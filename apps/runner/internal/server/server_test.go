package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/project-control/runner/internal/operations"
	"github.com/project-control/runner/internal/protocol"
	"github.com/project-control/runner/internal/registry"
)

// newTestServer starts a server on a socket inside t.TempDir().
func newTestServer(t *testing.T, ops ...registry.Operation) (*Server, string) {
	t.Helper()

	if len(ops) == 0 {
		ops = operations.All(operations.Config{
			WorkingDir: t.TempDir(),
			SocketPath: "/tmp/unused.sock",
			Version:    "test",
			StartedAt:  time.Now(),
		})
	}

	reg, err := registry.New(ops...)
	if err != nil {
		t.Fatalf("registry.New: %v", err)
	}

	socketPath := filepath.Join(t.TempDir(), "runner.sock")
	srv, err := New(Options{
		SocketPath:        socketPath,
		SocketGID:         os.Getgid(),
		MaxConcurrent:     2,
		MaxOutputRunes:    1024,
		ConnectionTimeout: 5 * time.Second,
		Registry:          reg,
		Logger:            slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = srv.Serve(ctx)
	}()

	t.Cleanup(func() {
		cancel()
		<-done
		_ = srv.Close()
	})

	return srv, socketPath
}

// send writes one raw line and reads one response line.
func send(t *testing.T, socketPath, payload string) protocol.Response {
	t.Helper()

	conn, err := net.DialTimeout("unix", socketPath, 3*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer func() { _ = conn.Close() }()

	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	if _, err := conn.Write([]byte(payload + "\n")); err != nil {
		t.Fatalf("write: %v", err)
	}

	raw, err := io.ReadAll(conn)
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	var response protocol.Response
	if err := json.Unmarshal([]byte(strings.TrimSpace(string(raw))), &response); err != nil {
		t.Fatalf("decode %q: %v", string(raw), err)
	}
	return response
}

func request(t *testing.T, socketPath, operation string, params any) protocol.Response {
	t.Helper()
	body := map[string]any{"requestId": "test-request-0001", "operation": operation}
	if params != nil {
		body["params"] = params
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return send(t, socketPath, string(encoded))
}

// -----------------------------------------------------------------------------
// Socket security
// -----------------------------------------------------------------------------

func TestSocketIsNotWorldAccessible(t *testing.T) {
	_, socketPath := newTestServer(t)

	info, err := os.Stat(socketPath)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm&0o007 != 0 {
		t.Fatalf("socket mode %04o grants access to other; want no 'other' bits", perm)
	}
	if perm := info.Mode().Perm(); perm != 0o660 {
		t.Fatalf("socket mode = %04o, want 0660", perm)
	}
}

func TestSocketGroupMatchesTheRunningProcessWithoutChown(t *testing.T) {
	// The socket must end up owned by the group the runner itself runs as
	// (os.Getgid(), mirroring Group=project-control in the systemd unit) purely
	// because a new file inherits its creator's effective GID — no chown(2) is
	// involved, which matters because the service has no CAP_CHOWN.
	_, socketPath := newTestServer(t)

	gid, err := socketGID(socketPath)
	if err != nil {
		t.Fatalf("socketGID: %v", err)
	}
	if gid != os.Getgid() {
		t.Fatalf("socket group = %d, want the process's own effective gid %d", gid, os.Getgid())
	}
}

func TestServerRefusesMismatchedSocketGID(t *testing.T) {
	// If SocketGID does not match the group the process actually runs as, the
	// socket's real group ownership (set by the kernel at creation time) will
	// not match it either. New must fail with an explicit error rather than
	// attempt a chown(2) that would only fail anyway without CAP_CHOWN.
	reg, _ := registry.New(operations.All(operations.Config{
		WorkingDir: t.TempDir(), SocketPath: "/tmp/x.sock", Version: "test", StartedAt: time.Now(),
	})...)

	wrongGID := os.Getgid() + 999_999

	_, err := New(Options{
		SocketPath: filepath.Join(t.TempDir(), "runner.sock"),
		SocketGID:  wrongGID,
		Registry:   reg,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err == nil {
		t.Fatal("expected New to refuse a socket whose actual group does not match SocketGID")
	}
	if !strings.Contains(err.Error(), "CAP_CHOWN") {
		t.Fatalf("error should explain that chown was refused rather than attempted, got: %v", err)
	}
}

func TestServerRefusesToStartWithoutSocketGroup(t *testing.T) {
	reg, _ := registry.New(operations.All(operations.Config{
		WorkingDir: t.TempDir(), SocketPath: "/tmp/x.sock", Version: "test", StartedAt: time.Now(),
	})...)

	_, err := New(Options{
		SocketPath: filepath.Join(t.TempDir(), "runner.sock"),
		SocketGID:  0, // not set
		Registry:   reg,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err == nil {
		t.Fatal("expected New to refuse a socket with no controlling group")
	}
}

func TestServerRefusesToRemoveANonSocketAtTheSocketPath(t *testing.T) {
	dir := t.TempDir()
	occupied := filepath.Join(dir, "runner.sock")
	if err := os.WriteFile(occupied, []byte("important file"), 0o600); err != nil {
		t.Fatal(err)
	}

	reg, _ := registry.New(operations.All(operations.Config{
		WorkingDir: dir, SocketPath: occupied, Version: "test", StartedAt: time.Now(),
	})...)

	_, err := New(Options{
		SocketPath: occupied,
		SocketGID:  os.Getgid(),
		Registry:   reg,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err == nil {
		t.Fatal("expected New to refuse to clobber a regular file")
	}
	if _, statErr := os.Stat(occupied); statErr != nil {
		t.Fatal("the pre-existing file was removed; it must be left untouched")
	}
}

// -----------------------------------------------------------------------------
// The core guarantee: no raw command execution
// -----------------------------------------------------------------------------

func TestRejectsShellCommandShapedRequests(t *testing.T) {
	_, socketPath := newTestServer(t)

	// Every one of these is a plausible attempt to smuggle execution through the
	// operation field. All must be rejected as unknown operations.
	hostile := []string{
		"/bin/sh",
		"sh -c 'id'",
		"bash",
		"exec",
		"run",
		"shell",
		"system.health; id",
		"system.health && id",
		"system.health|id",
		"$(id)",
		"`id`",
		"../../bin/sh",
		"system.health\nrunner.selftest",
		"SYSTEM.HEALTH",
		"system.Health",
		"system.health ",
		" system.health",
		"eval",
		"os.exec",
	}

	for _, operation := range hostile {
		body, err := json.Marshal(map[string]any{
			"requestId": "test-request-0001",
			"operation": operation,
		})
		if err != nil {
			t.Fatal(err)
		}
		response := send(t, socketPath, string(body))

		if response.OK {
			t.Fatalf("operation %q was accepted; the registry must reject it", operation)
		}
		if response.Error == nil {
			t.Fatalf("operation %q produced no error detail", operation)
		}
		if response.Error.Code != protocol.CodeUnknownOperation &&
			response.Error.Code != protocol.CodeInvalidRequest {
			t.Fatalf("operation %q rejected with code %q; want unknown_operation or invalid_request",
				operation, response.Error.Code)
		}
	}
}

func TestRejectsCommandCarryingFields(t *testing.T) {
	_, socketPath := newTestServer(t)

	// The protocol has no field for a command, so a request carrying one must be
	// rejected outright by DisallowUnknownFields rather than silently ignored.
	hostile := []string{
		`{"requestId":"test-request-0001","operation":"system.health","command":"id"}`,
		`{"requestId":"test-request-0001","operation":"system.health","cmd":"/bin/sh"}`,
		`{"requestId":"test-request-0001","operation":"system.health","script":"rm -rf /"}`,
		`{"requestId":"test-request-0001","operation":"system.health","argv":["sh","-c","id"]}`,
		`{"requestId":"test-request-0001","operation":"system.health","env":{"LD_PRELOAD":"/tmp/x.so"}}`,
		`{"requestId":"test-request-0001","operation":"system.health","cwd":"/"}`,
		`{"requestId":"test-request-0001","operation":"system.health","exec":true}`,
	}

	for _, payload := range hostile {
		response := send(t, socketPath, payload)
		if response.OK {
			t.Fatalf("request with an execution field was accepted: %s", payload)
		}
		if response.Error.Code != protocol.CodeInvalidRequest {
			t.Fatalf("payload %s rejected with %q; want invalid_request", payload, response.Error.Code)
		}
	}
}

func TestRejectsUnknownParameters(t *testing.T) {
	_, socketPath := newTestServer(t)

	// system.health declares no parameters, so any parameter is an error rather
	// than something to ignore.
	response := request(t, socketPath, "system.health", map[string]any{"command": "id"})
	if response.OK {
		t.Fatal("unknown parameter was accepted")
	}
	if response.Error.Code != protocol.CodeInvalidParams {
		t.Fatalf("code = %q, want invalid_params", response.Error.Code)
	}
}

// -----------------------------------------------------------------------------
// Allowlisted operations
// -----------------------------------------------------------------------------

func TestSystemHealthSucceeds(t *testing.T) {
	_, socketPath := newTestServer(t)

	response := request(t, socketPath, "system.health", nil)
	if !response.OK {
		t.Fatalf("system.health failed: %+v", response.Error)
	}
	if response.RequestID != "test-request-0001" {
		t.Fatalf("requestId = %q, want it echoed back", response.RequestID)
	}
	for _, key := range []string{"runnerVersion", "goVersion", "platform", "uptimeSeconds", "uid"} {
		if _, ok := response.Result[key]; !ok {
			t.Fatalf("result is missing %q: %+v", key, response.Result)
		}
	}
	if uid, ok := response.Result["uid"].(float64); ok && uid == 0 {
		t.Fatal("runner reports uid 0; it must not run as root")
	}
}

func TestRunnerSelfTestSucceeds(t *testing.T) {
	workingDir := t.TempDir()
	socketDir := t.TempDir()
	socketPath := filepath.Join(socketDir, "runner.sock")

	reg, err := registry.New(operations.All(operations.Config{
		WorkingDir: workingDir,
		SocketPath: socketPath,
		Version:    "test",
		StartedAt:  time.Now(),
	})...)
	if err != nil {
		t.Fatal(err)
	}

	srv, err := New(Options{
		SocketPath: socketPath, SocketGID: os.Getgid(), MaxConcurrent: 2,
		MaxOutputRunes: 1024, ConnectionTimeout: 5 * time.Second,
		Registry: reg, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { _ = srv.Serve(ctx) }()
	t.Cleanup(func() { cancel(); _ = srv.Close() })

	response := request(t, socketPath, "runner.selftest", nil)
	if !response.OK {
		t.Fatalf("runner.selftest failed: %+v", response.Error)
	}

	checks, ok := response.Result["checks"].(map[string]any)
	if !ok {
		t.Fatalf("checks missing from result: %+v", response.Result)
	}
	for _, name := range []string{
		"not_root", "no_setuid", "socket_not_world_accessible",
		"working_dir", "scratch_writable", "no_docker_socket_access",
	} {
		check, present := checks[name].(map[string]any)
		if !present {
			t.Fatalf("self-test did not report %q", name)
		}
		if passed, _ := check["ok"].(bool); !passed {
			t.Fatalf("self-test check %q failed: %+v", name, check)
		}
	}
}

// -----------------------------------------------------------------------------
// Envelope validation
// -----------------------------------------------------------------------------

func TestRejectsMalformedEnvelopes(t *testing.T) {
	_, socketPath := newTestServer(t)

	cases := map[string]string{
		"not json":           `this is not json`,
		"array":              `["system.health"]`,
		"missing requestId":  `{"operation":"system.health"}`,
		"short requestId":    `{"requestId":"abc","operation":"system.health"}`,
		"missing operation":  `{"requestId":"test-request-0001"}`,
		"empty operation":    `{"requestId":"test-request-0001","operation":""}`,
		"requestId newline":  `{"requestId":"test\nrequest0001","operation":"system.health"}`,
		"requestId too long": `{"requestId":"` + strings.Repeat("a", 100) + `","operation":"system.health"}`,
		"params not object":  `{"requestId":"test-request-0001","operation":"system.health","params":"string"}`,
	}

	for name, payload := range cases {
		t.Run(name, func(t *testing.T) {
			response := send(t, socketPath, payload)
			if response.OK {
				t.Fatalf("malformed envelope was accepted: %s", payload)
			}
		})
	}
}

func TestRejectsOversizedRequest(t *testing.T) {
	_, socketPath := newTestServer(t)

	huge := `{"requestId":"test-request-0001","operation":"system.health","params":{"x":"` +
		strings.Repeat("a", protocol.MaxRequestBytes+1024) + `"}}`

	response := send(t, socketPath, huge)
	if response.OK {
		t.Fatal("oversized request was accepted")
	}
	if response.Error.Code != protocol.CodeRequestTooLarge &&
		response.Error.Code != protocol.CodeInvalidRequest {
		t.Fatalf("code = %q, want request_too_large or invalid_request", response.Error.Code)
	}
}

// -----------------------------------------------------------------------------
// Timeouts, concurrency, panics
// -----------------------------------------------------------------------------

func TestOperationTimeoutIsEnforced(t *testing.T) {
	slow := registry.Operation{
		Name:           "test.slow",
		Description:    "sleeps past its timeout",
		TimeoutSeconds: 1,
		Handler: func(ctx context.Context, _ map[string]any) (map[string]any, error) {
			select {
			case <-time.After(10 * time.Second):
				return map[string]any{"finished": true}, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		},
	}
	_, socketPath := newTestServer(t, slow)

	started := time.Now()
	response := request(t, socketPath, "test.slow", nil)
	elapsed := time.Since(started)

	if response.OK {
		t.Fatal("a handler that outran its timeout reported success")
	}
	if response.Error.Code != protocol.CodeTimeout {
		t.Fatalf("code = %q, want timeout", response.Error.Code)
	}
	if elapsed > 5*time.Second {
		t.Fatalf("timeout took %v to fire; the 1 s budget was not enforced", elapsed)
	}
}

func TestConcurrencyLimitIsEnforced(t *testing.T) {
	blocking := registry.Operation{
		Name:           "test.block",
		Description:    "blocks so slots stay occupied",
		TimeoutSeconds: 5,
		Handler: func(ctx context.Context, _ map[string]any) (map[string]any, error) {
			select {
			case <-time.After(2 * time.Second):
			case <-ctx.Done():
			}
			return map[string]any{"done": true}, nil
		},
	}
	_, socketPath := newTestServer(t, blocking) // MaxConcurrent = 2

	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		codes []string
	)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			response := request(t, socketPath, "test.block", nil)
			mu.Lock()
			defer mu.Unlock()
			if response.Error != nil {
				codes = append(codes, response.Error.Code)
			} else {
				codes = append(codes, "ok")
			}
		}()
	}
	wg.Wait()

	busy := 0
	for _, code := range codes {
		if code == protocol.CodeBusy {
			busy++
		}
	}
	if busy == 0 {
		t.Fatalf("no request was rejected as busy with 6 concurrent calls against a limit of 2: %v", codes)
	}
}

func TestPanickingHandlerDoesNotKillTheServer(t *testing.T) {
	panicking := registry.Operation{
		Name:           "test.panic",
		Description:    "panics",
		TimeoutSeconds: 5,
		Handler: func(context.Context, map[string]any) (map[string]any, error) {
			panic("deliberate test panic")
		},
	}
	healthy := registry.Operation{
		Name:           "test.ok",
		Description:    "succeeds",
		TimeoutSeconds: 5,
		Handler: func(context.Context, map[string]any) (map[string]any, error) {
			return map[string]any{"fine": true}, nil
		},
	}
	_, socketPath := newTestServer(t, panicking, healthy)

	response := request(t, socketPath, "test.panic", nil)
	if response.OK {
		t.Fatal("a panicking handler reported success")
	}
	// The panic value must not be echoed to the caller.
	if strings.Contains(response.Error.Message, "deliberate test panic") {
		t.Fatalf("panic detail leaked to the caller: %q", response.Error.Message)
	}

	// The server must still be serving.
	after := request(t, socketPath, "test.ok", nil)
	if !after.OK {
		t.Fatalf("server stopped working after a handler panic: %+v", after.Error)
	}
}

// -----------------------------------------------------------------------------
// Output handling
// -----------------------------------------------------------------------------

func TestOutputIsRedactedAndTruncated(t *testing.T) {
	leaky := registry.Operation{
		Name:           "test.leak",
		Description:    "returns credential-shaped and oversized strings",
		TimeoutSeconds: 5,
		Handler: func(context.Context, map[string]any) (map[string]any, error) {
			return map[string]any{
				"connection": "postgresql://control_app:SuperSecret123@postgres:5432/db",
				"env":        "PASSWORD=hunter2 OTHER=fine",
				"telegram":   "123456789:AAHfaKeToKenValueForTestingPurposes123456",
				"long":       strings.Repeat("x", 5000),
			}, nil
		},
	}
	_, socketPath := newTestServer(t, leaky) // MaxOutputRunes = 1024

	response := request(t, socketPath, "test.leak", nil)
	if !response.OK {
		t.Fatalf("unexpected failure: %+v", response.Error)
	}

	encoded, _ := json.Marshal(response.Result)
	body := string(encoded)

	for _, leaked := range []string{"SuperSecret123", "hunter2", "AAHfaKeToKenValueForTestingPurposes123456"} {
		if strings.Contains(body, leaked) {
			t.Fatalf("secret %q survived redaction: %s", leaked, body)
		}
	}
	if long, ok := response.Result["long"].(string); ok {
		if len([]rune(long)) > 1024+len([]rune("…[truncated]")) {
			t.Fatalf("output was not truncated: %d runes", len([]rune(long)))
		}
	}
	if !response.Truncated {
		t.Fatal("response did not report truncation")
	}
}

func TestRejectsOverlongSocketPath(t *testing.T) {
	// sockaddr_un.sun_path is 108 bytes; bind(2) otherwise fails with a bare
	// EINVAL that gives an operator nothing to go on.
	reg, _ := registry.New(operations.All(operations.Config{
		WorkingDir: t.TempDir(), SocketPath: "/tmp/x.sock", Version: "test", StartedAt: time.Now(),
	})...)

	long := filepath.Join(t.TempDir(), strings.Repeat("d", 120)+".sock")

	_, err := New(Options{
		SocketPath: long,
		SocketGID:  os.Getgid(),
		Registry:   reg,
		Logger:     slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err == nil {
		t.Fatal("expected New to reject a socket path longer than the kernel limit")
	}
	if !strings.Contains(err.Error(), "kernel limit") {
		t.Fatalf("error should explain the limit, got: %v", err)
	}
}
