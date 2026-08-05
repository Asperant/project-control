// Package redact removes credential-shaped substrings from text before it is
// logged or returned to a caller.
//
// This is a safety net, not the primary control: the Stage 1 operations do not
// read secrets at all. It exists because operation output is the natural place
// for a future operation to accidentally surface an environment variable or a
// connection string, and a net that is already in place cannot be forgotten.
package redact

import (
	"regexp"
	"strings"
)

const placeholder = "***REDACTED***"

var patterns = []*regexp.Regexp{
	// key=value / key: value forms for credential-ish key names.
	regexp.MustCompile(`(?i)\b(password|passwd|pwd|secret|token|api[_-]?key|encryption[_-]?key|auth[_-]?token|bearer)\b\s*[:=]\s*\S+`),
	// PostgreSQL and similar URIs with inline credentials.
	regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.-]*://[^\s:/@]+:[^\s@]+@`),
	// Telegram bot tokens: <numeric id>:<35-char base64url-ish>.
	regexp.MustCompile(`\b\d{8,12}:[A-Za-z0-9_-]{30,}\b`),
	// PEM private key blocks.
	regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`),
	// Argon2/bcrypt PHC strings.
	regexp.MustCompile(`\$(argon2[a-z]*|2[aby])\$[^\s]+`),
	// AWS-style long-lived access key ids.
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
}

// String returns s with credential-shaped substrings replaced.
func String(s string) string {
	if s == "" {
		return s
	}
	out := s
	for _, pattern := range patterns {
		out = pattern.ReplaceAllString(out, placeholder)
	}
	return out
}

// Map applies String to every string value in a result map, recursively.
func Map(in map[string]any) map[string]any {
	if in == nil {
		return map[string]any{}
	}
	out := make(map[string]any, len(in))
	for key, value := range in {
		out[key] = walk(value, 0)
	}
	return out
}

func walk(value any, depth int) any {
	if depth > 6 {
		return placeholder
	}
	switch typed := value.(type) {
	case string:
		return String(typed)
	case map[string]any:
		nested := make(map[string]any, len(typed))
		for k, v := range typed {
			nested[k] = walk(v, depth+1)
		}
		return nested
	case []any:
		nested := make([]any, 0, len(typed))
		for _, v := range typed {
			nested = append(nested, walk(v, depth+1))
		}
		return nested
	default:
		return value
	}
}

// Truncate bounds a string to max runes, appending an ellipsis marker when it
// had to cut. Operating on runes rather than bytes avoids splitting a
// multi-byte character and producing invalid UTF-8 in the JSON response.
func Truncate(s string, max int) (string, bool) {
	if max <= 0 {
		return "", len(s) > 0
	}
	runes := []rune(s)
	if len(runes) <= max {
		return s, false
	}
	return string(runes[:max]) + "…[truncated]", true
}

// SanitiseLine makes a string safe to write into a single log line: control
// characters and terminal escape sequences are stripped so a hostile value
// cannot forge log entries or manipulate an operator's terminal.
func SanitiseLine(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		switch {
		case r == '\n' || r == '\r':
			b.WriteByte(' ')
		case r < 0x20 || r == 0x7f:
			// Drop other control characters, including ESC (0x1b).
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
