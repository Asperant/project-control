// Package server implements the Unix-socket listener and request dispatch.
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/project-control/runner/internal/protocol"
	"github.com/project-control/runner/internal/redact"
	"github.com/project-control/runner/internal/registry"
)

// Options configures the server.
type Options struct {
	SocketPath string
	// SocketGID owns the socket's group. Only members of that group can talk to
	// the runner; this is the entire access-control mechanism, so it must be set.
	SocketGID int
	// MaxConcurrent bounds simultaneous operation executions.
	MaxConcurrent int
	// ConnectionTimeout bounds how long a single connection may take end to end,
	// including a client that connects and then never sends anything.
	ConnectionTimeout time.Duration
	// MaxOutputRunes truncates operation output.
	MaxOutputRunes int
	Registry       *registry.Registry
	Logger         *slog.Logger
}

// Server accepts connections on a Unix domain socket.
type Server struct {
	opts     Options
	listener net.Listener
	// semaphore enforces MaxConcurrent. A bounded channel is used rather than a
	// worker pool so an over-limit request fails fast with `busy` instead of
	// queueing indefinitely.
	semaphore chan struct{}
	wg        sync.WaitGroup
}

// New validates the options and creates the socket.
//
// Socket creation deliberately happens here rather than lazily: if the socket
// cannot be created with the correct ownership and mode, the process must fail
// to start rather than run with a socket that is more permissive than intended.
func New(opts Options) (*Server, error) {
	if opts.Registry == nil {
		return nil, errors.New("registry is required")
	}
	if opts.Logger == nil {
		return nil, errors.New("logger is required")
	}
	if opts.SocketGID <= 0 {
		return nil, errors.New("socket group id must be set; refusing to expose the socket without group ownership")
	}
	if opts.MaxConcurrent <= 0 {
		opts.MaxConcurrent = 4
	}
	if opts.ConnectionTimeout <= 0 {
		opts.ConnectionTimeout = 30 * time.Second
	}
	if opts.MaxOutputRunes <= 0 {
		opts.MaxOutputRunes = 8192
	}

	// sockaddr_un.sun_path is a fixed 108-byte buffer on Linux. bind(2) fails
	// with a bare EINVAL when the path is longer, which is an unhelpful thing to
	// debug — so it is caught here with a message that says what is wrong.
	const maxUnixSocketPath = 107
	if len(opts.SocketPath) > maxUnixSocketPath {
		return nil, fmt.Errorf(
			"socket path is %d bytes; the kernel limit is %d (sockaddr_un.sun_path): %s",
			len(opts.SocketPath), maxUnixSocketPath, opts.SocketPath)
	}

	socketDir := filepath.Dir(opts.SocketPath)
	if err := os.MkdirAll(socketDir, 0o750); err != nil {
		return nil, fmt.Errorf("cannot create socket directory: %w", err)
	}

	// Remove a stale socket left by an unclean shutdown. Only a socket is
	// removed — if something else occupies the path, that is an unexpected
	// condition and the process refuses to continue rather than deleting it.
	if info, err := os.Lstat(opts.SocketPath); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, fmt.Errorf("%s exists and is not a socket; refusing to remove it", opts.SocketPath)
		}
		if err := os.Remove(opts.SocketPath); err != nil {
			return nil, fmt.Errorf("cannot remove stale socket: %w", err)
		}
	}

	// Create the socket with a restrictive umask so there is no window in which
	// it exists with wider permissions than intended.
	oldMask := setUmask(0o177)
	listener, err := net.Listen("unix", opts.SocketPath)
	setUmask(oldMask)
	if err != nil {
		return nil, fmt.Errorf("cannot listen on %s: %w", opts.SocketPath, err)
	}

	// A new file's group is its creator's effective GID (Linux gives the parent
	// directory's setgid bit priority, but RuntimeDirectory carries none here) —
	// so as long as the process runs with Group=project-control, as the systemd
	// unit requires, the socket already has the right group the instant it is
	// created. That is verified rather than corrected: chown(2) to a group the
	// caller does not hold via its own GID needs CAP_CHOWN, which this service
	// deliberately is never granted, so calling it here would only ever fail.
	// A mismatch means the process's own identity is wrong, which must be a
	// clear startup error rather than a chown attempt papering over it.
	gotGID, err := socketGID(opts.SocketPath)
	if err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("cannot verify socket group ownership: %w", err)
	}
	if gotGID != opts.SocketGID {
		_ = listener.Close()
		return nil, fmt.Errorf(
			"socket %s was created with group %d, not the expected %d; "+
				"the runner process must itself run with the target group (see Group= in the systemd unit) — "+
				"refusing to chown, since the service has no CAP_CHOWN",
			opts.SocketPath, gotGID, opts.SocketGID)
	}
	if err := os.Chmod(opts.SocketPath, 0o660); err != nil {
		_ = listener.Close()
		return nil, fmt.Errorf("cannot set socket mode: %w", err)
	}

	opts.Logger.Info("listening",
		"socket", opts.SocketPath,
		"gid", opts.SocketGID,
		"mode", "0660",
		"operations", opts.Registry.Names(),
		"maxConcurrent", opts.MaxConcurrent,
	)

	return &Server{
		opts:      opts,
		listener:  listener,
		semaphore: make(chan struct{}, opts.MaxConcurrent),
	}, nil
}

// Serve accepts connections until ctx is cancelled.
func (s *Server) Serve(ctx context.Context) error {
	go func() {
		<-ctx.Done()
		_ = s.listener.Close()
	}()

	for {
		conn, err := s.listener.Accept()
		if err != nil {
			if ctx.Err() != nil {
				// Expected: the listener was closed by the shutdown goroutine.
				s.wg.Wait()
				return nil
			}
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				continue
			}
			return fmt.Errorf("accept failed: %w", err)
		}

		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			s.handleConnection(ctx, conn)
		}()
	}
}

// Close releases the listener and removes the socket file.
func (s *Server) Close() error {
	err := s.listener.Close()
	// net.Listener for unix sockets unlinks the file itself, but an explicit
	// removal covers the case where it did not.
	_ = os.Remove(s.opts.SocketPath)
	return err
}

func (s *Server) handleConnection(ctx context.Context, conn net.Conn) {
	defer func() { _ = conn.Close() }()

	// A client that connects and stalls must not hold a slot forever.
	deadline := time.Now().Add(s.opts.ConnectionTimeout)
	_ = conn.SetDeadline(deadline)

	started := time.Now()

	// Read exactly one line, bounded. A caller that sends more than
	// MaxRequestBytes without a newline is cut off rather than buffered.
	reader := bufio.NewReaderSize(io.LimitReader(conn, protocol.MaxRequestBytes+1), 8192)
	line, err := reader.ReadBytes('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		s.writeResponse(conn, protocol.NewErrorResponse("", "", protocol.CodeInvalidRequest,
			"could not read request", time.Since(started).Milliseconds()))
		return
	}
	if len(line) > protocol.MaxRequestBytes {
		s.opts.Logger.Warn("request rejected", "reason", "too_large", "bytes", len(line))
		// The peer is still writing the rest of its oversized payload. Closing
		// now would send an RST and destroy the response before the client could
		// read it, so the remainder is drained (bounded) first.
		s.drain(conn)
		s.writeResponse(conn, protocol.NewErrorResponse("", "", protocol.CodeRequestTooLarge,
			"request exceeds the maximum permitted size", time.Since(started).Milliseconds()))
		return
	}
	if len(line) == 0 {
		return
	}

	var request protocol.Request
	decoder := json.NewDecoder(newBounded(line))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		s.opts.Logger.Warn("request rejected", "reason", "malformed_json")
		s.writeResponse(conn, protocol.NewErrorResponse("", "", protocol.CodeInvalidRequest,
			"request is not a valid JSON object with the expected fields",
			time.Since(started).Milliseconds()))
		return
	}

	if err := protocol.ValidateRequest(&request); err != nil {
		s.opts.Logger.Warn("request rejected",
			"reason", "envelope_invalid",
			"detail", redact.SanitiseLine(err.Error()))
		s.writeResponse(conn, protocol.NewErrorResponse(request.RequestID, request.Operation,
			protocol.CodeInvalidRequest, redact.SanitiseLine(err.Error()),
			time.Since(started).Milliseconds()))
		return
	}

	s.writeResponse(conn, s.dispatch(ctx, request, started))
}

// dispatch looks the operation up and runs it under its declared timeout.
func (s *Server) dispatch(ctx context.Context, request protocol.Request, started time.Time) protocol.Response {
	logger := s.opts.Logger.With(
		"requestId", redact.SanitiseLine(request.RequestID),
		"operation", redact.SanitiseLine(request.Operation),
	)

	operation, err := s.opts.Registry.Lookup(request.Operation)
	if err != nil {
		// The audit line records the attempted name so an operator can see a
		// caller probing for operations that do not exist.
		logger.Warn("operation rejected", "reason", "unknown_operation")
		return protocol.NewErrorResponse(request.RequestID, request.Operation,
			protocol.CodeUnknownOperation,
			"operation is not in the runner's registry",
			time.Since(started).Milliseconds())
	}

	params, err := registry.ValidateParams(operation, request.Params)
	if err != nil {
		logger.Warn("operation rejected", "reason", "invalid_params",
			"detail", redact.SanitiseLine(err.Error()))
		return protocol.NewErrorResponse(request.RequestID, request.Operation,
			protocol.CodeInvalidParams, redact.SanitiseLine(err.Error()),
			time.Since(started).Milliseconds())
	}

	// Concurrency gate. Non-blocking: over the limit, the caller is told to
	// retry rather than being queued behind an unknown amount of work.
	select {
	case s.semaphore <- struct{}{}:
		defer func() { <-s.semaphore }()
	default:
		logger.Warn("operation rejected", "reason", "busy")
		return protocol.NewErrorResponse(request.RequestID, request.Operation,
			protocol.CodeBusy, "runner is at its concurrency limit; retry shortly",
			time.Since(started).Milliseconds())
	}

	opCtx, cancel := context.WithTimeout(ctx, time.Duration(operation.TimeoutSeconds)*time.Second)
	defer cancel()

	logger.Info("operation started")

	result, opErr := runGuarded(opCtx, operation, params)
	elapsed := time.Since(started).Milliseconds()

	if opErr != nil {
		code := protocol.CodeOperationFailed
		if errors.Is(opErr, context.DeadlineExceeded) {
			code = protocol.CodeTimeout
		}
		logger.Warn("operation failed",
			"code", code,
			"durationMs", elapsed,
			"detail", redact.SanitiseLine(opErr.Error()))
		return protocol.NewErrorResponse(request.RequestID, request.Operation, code,
			redact.SanitiseLine(opErr.Error()), elapsed)
	}

	// Redact, then bound the size of every string in the result.
	safe := redact.Map(result)
	truncated := boundStrings(safe, s.opts.MaxOutputRunes)

	logger.Info("operation completed", "durationMs", elapsed, "truncated", truncated)

	return protocol.Response{
		RequestID:  request.RequestID,
		Operation:  request.Operation,
		OK:         true,
		Result:     safe,
		Error:      nil,
		DurationMS: elapsed,
		Truncated:  truncated,
	}
}

// handlerOutcome carries a handler's result across the goroutine boundary.
//
// The result travels through a channel rather than through captured variables:
// with captured variables, the timeout branch below would read them while the
// handler goroutine was still writing to them, which is a data race.
type handlerOutcome struct {
	result map[string]any
	err    error
}

// runGuarded executes a handler under its timeout, converting a panic into an
// error.
//
// A panicking handler must not take the whole runner down: the process is a
// long-lived system service, and a crash means every subsequent request fails
// until systemd restarts it. The recover() therefore lives *inside* the
// goroutine that runs the handler — a deferred recover in this function would
// not see a panic raised on a different goroutine, and the process would die.
func runGuarded(ctx context.Context, operation registry.Operation, params map[string]any) (map[string]any, error) {
	// Buffered so the handler goroutine can always deliver its outcome and exit,
	// even when the timeout branch has already returned and nobody is reading.
	outcome := make(chan handlerOutcome, 1)

	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				// The panic value is deliberately not propagated: it can embed
				// arbitrary internal state, and the caller only needs to know the
				// operation failed.
				outcome <- handlerOutcome{result: nil, err: errors.New("operation panicked")}
			}
		}()

		result, err := operation.Handler(ctx, params)
		outcome <- handlerOutcome{result: result, err: err}
	}()

	select {
	case settled := <-outcome:
		return settled.result, settled.err
	case <-ctx.Done():
		// The handler goroutine may still be running; it observes ctx and is
		// expected to stop. Its result is discarded either way.
		return nil, ctx.Err()
	}
}

// drainLimit bounds how much of a rejected oversized request will be read and
// discarded. Generous enough that a normal client's in-flight buffer drains,
// small enough that a hostile client cannot make the runner read forever.
const drainLimit = 4 * protocol.MaxRequestBytes

// drain discards pending input so that closing the connection does not reset it
// before the peer has read our response.
func (s *Server) drain(conn net.Conn) {
	// Short, independent deadline: a client that stops sending must not hold the
	// connection for the full ConnectionTimeout.
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _ = io.Copy(io.Discard, io.LimitReader(conn, drainLimit))
	// Restore a write deadline for the response that follows.
	_ = conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
}

func (s *Server) writeResponse(conn net.Conn, response protocol.Response) {
	if response.Result == nil {
		response.Result = map[string]any{}
	}

	encoded, err := json.Marshal(response)
	if err != nil {
		s.opts.Logger.Error("cannot encode response", "error", err)
		encoded = []byte(`{"ok":false,"error":{"code":"internal_error","message":"response encoding failed"},"result":{},"durationMs":0,"truncated":false,"requestId":"unknown","operation":"unknown"}`)
	}
	if len(encoded) > protocol.MaxResponseBytes {
		s.opts.Logger.Warn("response exceeded size limit", "bytes", len(encoded))
		trimmed := protocol.NewErrorResponse(response.RequestID, response.Operation,
			protocol.CodeInternal, "response exceeded the maximum permitted size", response.DurationMS)
		encoded, _ = json.Marshal(trimmed)
	}

	encoded = append(encoded, '\n')
	if _, err := conn.Write(encoded); err != nil {
		s.opts.Logger.Warn("cannot write response", "error", err)
	}
}

// boundStrings truncates every string in the map, reporting whether anything
// was cut.
func boundStrings(m map[string]any, max int) bool {
	truncated := false
	var walk func(v any, depth int) any
	walk = func(v any, depth int) any {
		if depth > 6 {
			return "…[truncated]"
		}
		switch typed := v.(type) {
		case string:
			out, cut := redact.Truncate(typed, max)
			if cut {
				truncated = true
			}
			return out
		case map[string]any:
			for k, nested := range typed {
				typed[k] = walk(nested, depth+1)
			}
			return typed
		case []any:
			for i, nested := range typed {
				typed[i] = walk(nested, depth+1)
			}
			return typed
		default:
			return v
		}
	}
	for k, v := range m {
		m[k] = walk(v, 0)
	}
	return truncated
}
