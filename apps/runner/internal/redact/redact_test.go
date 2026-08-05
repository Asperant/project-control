package redact

import (
	"strings"
	"testing"
)

func TestStringRedactsCredentialShapes(t *testing.T) {
	cases := map[string]string{
		"key=value":      "PASSWORD=hunter2",
		"key: value":     "password: hunter2",
		"mixed case":     "ApiKey=abcdef123456",
		"api_key":        "api_key=abcdef123456",
		"token":          "token: ghp_abcdefghijklmnop",
		"bearer":         "bearer: eyJhbGciOiJIUzI1NiJ9",
		"encryption key": "encryption_key=0123456789abcdef",
		"postgres uri":   "postgresql://control_app:SuperSecret@postgres:5432/db",
		"generic uri":    "amqp://user:p4ssw0rd@rabbit:5672/",
		"telegram token": "123456789:AAHfaKeToKenValueForTestingPurposes123",
		"argon2 hash":    "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaHZhbHVl",
		"bcrypt hash":    "$2b$12$abcdefghijklmnopqrstuv",
		"aws key id":     "AKIAIOSFODNN7EXAMPLE",
	}

	secrets := []string{
		"hunter2", "abcdef123456", "ghp_abcdefghijklmnop", "SuperSecret",
		"p4ssw0rd", "AAHfaKeToKenValueForTestingPurposes123", "aGFzaHZhbHVl",
		"AKIAIOSFODNN7EXAMPLE", "0123456789abcdef", "eyJhbGciOiJIUzI1NiJ9",
	}

	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			output := String(input)
			if output == input {
				t.Fatalf("nothing was redacted in %q", input)
			}
			for _, secret := range secrets {
				if strings.Contains(input, secret) && strings.Contains(output, secret) {
					t.Fatalf("secret %q survived redaction of %q -> %q", secret, input, output)
				}
			}
		})
	}
}

func TestStringRedactsPrivateKeyBlocks(t *testing.T) {
	pem := "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
	if out := String(pem); strings.Contains(out, "MIIEowIBAAKCAQEA") {
		t.Fatalf("private key material survived: %q", out)
	}
}

func TestStringLeavesBenignTextAlone(t *testing.T) {
	benign := []string{
		"", "runner started", "uid=1001 gid=1002", "disk free 226 GiB",
		"operation system.health completed in 3 ms", "https://example.ts.net:8443/",
	}
	for _, input := range benign {
		if got := String(input); got != input {
			t.Fatalf("String(%q) = %q; benign text must be untouched", input, got)
		}
	}
}

func TestMapRedactsRecursively(t *testing.T) {
	in := map[string]any{
		"safe": "fine",
		"nested": map[string]any{
			"conn": "postgresql://u:secretpw@host/db",
			"deeper": map[string]any{
				"env": "PASSWORD=leaked",
			},
		},
		"list":   []any{"token=abcdef123456", "ok"},
		"number": 42,
	}

	out := Map(in)

	flat := flatten(out)
	for _, secret := range []string{"secretpw", "leaked", "abcdef123456"} {
		if strings.Contains(flat, secret) {
			t.Fatalf("secret %q survived Map: %s", secret, flat)
		}
	}
	if !strings.Contains(flat, "fine") {
		t.Fatal("benign value was removed")
	}
	if out["number"] != 42 {
		t.Fatalf("non-string value was altered: %v", out["number"])
	}
}

func TestMapHandlesNil(t *testing.T) {
	out := Map(nil)
	if out == nil || len(out) != 0 {
		t.Fatalf("Map(nil) = %v, want an empty non-nil map", out)
	}
}

func TestTruncate(t *testing.T) {
	short, cut := Truncate("hello", 10)
	if cut || short != "hello" {
		t.Fatalf("short string was truncated: %q %v", short, cut)
	}

	long, cut := Truncate(strings.Repeat("a", 100), 10)
	if !cut {
		t.Fatal("long string was not reported as truncated")
	}
	if !strings.HasPrefix(long, strings.Repeat("a", 10)) {
		t.Fatalf("truncated value = %q", long)
	}

	// Multi-byte input must not be split mid-character.
	multi, _ := Truncate(strings.Repeat("ü", 20), 5)
	if !strings.HasPrefix(multi, "üüüüü") {
		t.Fatalf("multi-byte truncation produced %q", multi)
	}
}

func TestSanitiseLineStripsControlCharacters(t *testing.T) {
	hostile := "normal\x1b[31mRED\x1b[0m\nsecond line\r\x00\x07"
	out := SanitiseLine(hostile)

	for _, forbidden := range []string{"\x1b", "\x00", "\x07", "\n", "\r"} {
		if strings.Contains(out, forbidden) {
			t.Fatalf("control character %q survived: %q", forbidden, out)
		}
	}
	if !strings.Contains(out, "normal") || !strings.Contains(out, "second line") {
		t.Fatalf("legitimate text was lost: %q", out)
	}
}

func flatten(m map[string]any) string {
	var b strings.Builder
	var walk func(any)
	walk = func(v any) {
		switch typed := v.(type) {
		case string:
			b.WriteString(typed)
			b.WriteByte('|')
		case map[string]any:
			for _, nested := range typed {
				walk(nested)
			}
		case []any:
			for _, nested := range typed {
				walk(nested)
			}
		}
	}
	walk(m)
	return b.String()
}
