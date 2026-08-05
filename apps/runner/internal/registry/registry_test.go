package registry

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

func noopHandler(context.Context, map[string]any) (map[string]any, error) {
	return map[string]any{}, nil
}

func testOperation(name string, params ...ParamSpec) Operation {
	return Operation{
		Name:           name,
		Description:    "test",
		TimeoutSeconds: 5,
		Params:         params,
		Handler:        noopHandler,
	}
}

func TestNewRejectsInvalidOperations(t *testing.T) {
	cases := map[string]Operation{
		"empty name":  {Name: "", TimeoutSeconds: 5, Handler: noopHandler},
		"no handler":  {Name: "x", TimeoutSeconds: 5, Handler: nil},
		"no timeout":  {Name: "x", TimeoutSeconds: 0, Handler: noopHandler},
		"neg timeout": {Name: "x", TimeoutSeconds: -1, Handler: noopHandler},
	}

	for name, op := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := New(op); err == nil {
				t.Fatalf("New accepted an invalid operation (%s)", name)
			}
		})
	}
}

func TestNewRejectsDuplicateNames(t *testing.T) {
	if _, err := New(testOperation("dup"), testOperation("dup")); err == nil {
		t.Fatal("New accepted a duplicate operation name")
	}
}

func TestLookupIsExactMatchOnly(t *testing.T) {
	reg, err := New(testOperation("system.health"))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := reg.Lookup("system.health"); err != nil {
		t.Fatalf("exact name should resolve: %v", err)
	}

	// Anything that is not spelled exactly as registered must be unknown. No
	// case folding, no trimming, no prefix matching.
	for _, name := range []string{
		"System.Health", "SYSTEM.HEALTH", " system.health", "system.health ",
		"system.health\n", "system", "system.", "health", "system.health;id",
		"system.health\x00", "*", "",
	} {
		if _, err := reg.Lookup(name); !errors.Is(err, ErrUnknownOperation) {
			t.Fatalf("Lookup(%q) resolved; it must be unknown", name)
		}
	}
}

func TestNamesAreSorted(t *testing.T) {
	reg, err := New(testOperation("b.op"), testOperation("a.op"), testOperation("c.op"))
	if err != nil {
		t.Fatal(err)
	}
	names := reg.Names()
	if len(names) != 3 || names[0] != "a.op" || names[1] != "b.op" || names[2] != "c.op" {
		t.Fatalf("Names() = %v, want sorted", names)
	}
}

func TestValidateParamsRejectsUnknownKeys(t *testing.T) {
	op := testOperation("test.op") // declares no parameters

	for _, raw := range []string{
		`{"command":"id"}`,
		`{"cmd":"sh"}`,
		`{"anything":1}`,
		`{"":"empty key"}`,
	} {
		if _, err := ValidateParams(op, json.RawMessage(raw)); err == nil {
			t.Fatalf("ValidateParams accepted unknown key in %s", raw)
		}
	}
}

func TestValidateParamsAcceptsDeclaredKeys(t *testing.T) {
	op := testOperation("test.op",
		ParamSpec{Name: "label", Type: "string", Required: true, MaxLength: 32},
		ParamSpec{Name: "verbose", Type: "bool"},
	)

	params, err := ValidateParams(op, json.RawMessage(`{"label":"hello","verbose":true}`))
	if err != nil {
		t.Fatalf("ValidateParams rejected valid params: %v", err)
	}
	if params["label"] != "hello" || params["verbose"] != true {
		t.Fatalf("params = %+v", params)
	}
}

func TestValidateParamsEnforcesRequired(t *testing.T) {
	op := testOperation("test.op",
		ParamSpec{Name: "label", Type: "string", Required: true},
	)

	if _, err := ValidateParams(op, json.RawMessage(`{}`)); err == nil {
		t.Fatal("missing required parameter was accepted")
	}
	if _, err := ValidateParams(op, nil); err == nil {
		t.Fatal("absent params object with a required parameter was accepted")
	}
}

func TestValidateParamsEnforcesTypes(t *testing.T) {
	op := testOperation("test.op",
		ParamSpec{Name: "label", Type: "string"},
		ParamSpec{Name: "verbose", Type: "bool"},
		ParamSpec{Name: "count", Type: "number"},
	)

	cases := []string{
		`{"label":123}`,
		`{"label":true}`,
		`{"label":null}`,
		`{"label":{"nested":"object"}}`,
		`{"label":["array"]}`,
		`{"verbose":"yes"}`,
		`{"count":"5"}`,
	}
	for _, raw := range cases {
		if _, err := ValidateParams(op, json.RawMessage(raw)); err == nil {
			t.Fatalf("ValidateParams accepted a type mismatch: %s", raw)
		}
	}
}

func TestValidateParamsEnforcesStringLength(t *testing.T) {
	op := testOperation("test.op",
		ParamSpec{Name: "label", Type: "string", MaxLength: 10},
	)

	raw, _ := json.Marshal(map[string]string{"label": strings.Repeat("a", 11)})
	if _, err := ValidateParams(op, raw); err == nil {
		t.Fatal("over-length string was accepted")
	}

	ok, _ := json.Marshal(map[string]string{"label": strings.Repeat("a", 10)})
	if _, err := ValidateParams(op, ok); err != nil {
		t.Fatalf("at-limit string was rejected: %v", err)
	}
}

func TestValidateParamsRejectsNonObjects(t *testing.T) {
	op := testOperation("test.op")

	for _, raw := range []string{`"string"`, `123`, `["a"]`, `true`, `{}{}`, `not json`} {
		if _, err := ValidateParams(op, json.RawMessage(raw)); err == nil {
			t.Fatalf("ValidateParams accepted non-object params: %s", raw)
		}
	}
}

func TestValidateParamsTreatsJSONNullAsEmpty(t *testing.T) {
	// `"params": null` is a legitimate way to say "no parameters". It must
	// normalise to an empty, non-nil map rather than a nil one that a handler
	// would have to guard against.
	params, err := ValidateParams(testOperation("test.op"), json.RawMessage(`null`))
	if err != nil {
		t.Fatalf("null params rejected: %v", err)
	}
	if params == nil {
		t.Fatal("null params produced a nil map; want an empty map")
	}
	if len(params) != 0 {
		t.Fatalf("params = %+v, want empty", params)
	}

	// A required parameter must still be enforced when params is null.
	withRequired := testOperation("test.op", ParamSpec{Name: "label", Type: "string", Required: true})
	if _, err := ValidateParams(withRequired, json.RawMessage(`null`)); err == nil {
		t.Fatal("null params satisfied a required parameter")
	}
}

func TestValidateParamsAcceptsAbsentParams(t *testing.T) {
	op := testOperation("test.op")
	params, err := ValidateParams(op, nil)
	if err != nil {
		t.Fatalf("absent params rejected: %v", err)
	}
	if len(params) != 0 {
		t.Fatalf("params = %+v, want empty", params)
	}
}
