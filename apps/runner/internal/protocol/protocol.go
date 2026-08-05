// Package protocol defines the newline-delimited JSON wire format spoken over
// the runner's Unix domain socket.
//
// The format is deliberately minimal: one request object, one response object,
// connection closed. There is no session, no streaming and no multiplexing,
// which removes an entire class of framing and state-confusion bugs.
package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// MaxRequestBytes caps a single request. A request is a short JSON object; a
// megabyte would already be pathological, so the limit is set well below that
// to bound the memory a single connection can force the runner to allocate.
const MaxRequestBytes = 64 * 1024

// MaxResponseBytes caps what the runner will emit. Operation output is
// truncated to fit rather than allowed to grow without bound.
const MaxResponseBytes = 256 * 1024

// requestIDPattern constrains the caller-supplied correlation id. It is echoed
// into logs and audit records, so it must not be able to carry newlines,
// terminal escape sequences or arbitrary length.
var requestIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// Request is what the Control API sends.
//
// Note what is absent and will never be added: there is no Command field, no
// Args, no Script, no Cwd, no Env. The runner cannot be asked to execute
// anything; it can only be asked to perform an operation that already exists in
// its compiled-in registry.
type Request struct {
	RequestID string          `json:"requestId"`
	Operation string          `json:"operation"`
	Params    json.RawMessage `json:"params,omitempty"`
}

// Response is what the runner replies with.
type Response struct {
	RequestID  string         `json:"requestId"`
	Operation  string         `json:"operation"`
	OK         bool           `json:"ok"`
	Result     map[string]any `json:"result"`
	Error      *Error         `json:"error"`
	DurationMS int64          `json:"durationMs"`
	Truncated  bool           `json:"truncated"`
}

// Error is the structured failure detail. Message is operator-facing text that
// callers may log; it must never contain secret material.
type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Error codes. A closed set, so the caller can branch on them.
const (
	CodeInvalidRequest   = "invalid_request"
	CodeUnknownOperation = "unknown_operation"
	CodeInvalidParams    = "invalid_params"
	CodeTimeout          = "timeout"
	CodeBusy             = "busy"
	CodeInternal         = "internal_error"
	CodeOperationFailed  = "operation_failed"
	CodeRequestTooLarge  = "request_too_large"
)

var (
	// ErrRequestTooLarge is returned when a request exceeds MaxRequestBytes.
	ErrRequestTooLarge = errors.New("request exceeds the maximum permitted size")
)

// ValidateRequest checks the envelope before any operation is looked up.
//
// This runs first and unconditionally, so a malformed request is rejected
// without the operation registry, the parameter decoder or any handler being
// reached.
func ValidateRequest(r *Request) error {
	if r == nil {
		return errors.New("request is empty")
	}
	if !requestIDPattern.MatchString(r.RequestID) {
		return fmt.Errorf("requestId must match %s", requestIDPattern.String())
	}
	if r.Operation == "" {
		return errors.New("operation is required")
	}
	// Operation names are matched against the registry with an exact string
	// comparison, but a length bound stops a caller forcing a large allocation
	// or a huge log line before that comparison happens.
	if len(r.Operation) > 64 {
		return errors.New("operation name is too long")
	}
	if len(r.Params) > MaxRequestBytes {
		return ErrRequestTooLarge
	}
	return nil
}

// NewErrorResponse builds a failure response for a request that may not have
// parsed. Callers pass empty strings when the field is unknown.
func NewErrorResponse(requestID, operation, code, message string, durationMS int64) Response {
	if requestID == "" {
		requestID = "unknown"
	}
	if operation == "" {
		operation = "unknown"
	}
	return Response{
		RequestID:  requestID,
		Operation:  operation,
		OK:         false,
		Result:     map[string]any{},
		Error:      &Error{Code: code, Message: message},
		DurationMS: durationMS,
	}
}
