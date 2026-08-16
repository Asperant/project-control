// Package registry holds the fixed set of operations the runner can perform.
//
// The registry is populated at package initialisation from a compiled-in table
// and is never mutated afterwards. There is no registration API, no plugin
// loading, no configuration file that can add an operation, and no path by
// which caller input becomes an operation. Adding an operation requires editing
// this file and rebuilding the binary.
package registry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
)

// Handler performs one operation. It receives already-validated parameters and
// a context that is cancelled when the operation's timeout expires.
//
// A handler returns structured data. It has no way to return raw bytes to be
// interpreted, and no way to influence how the caller uses the result.
type Handler func(ctx context.Context, params map[string]any) (map[string]any, error)

// ParamSpec describes one accepted parameter.
type ParamSpec struct {
	Name     string
	Type     string // "string" | "bool" | "number" | "string[]"
	Required bool
	// MaxLength bounds string parameters, and each element of a "string[]"
	// parameter. Zero means the default of 256.
	MaxLength int
	// MaxItems bounds a "string[]" parameter's length. Zero means the
	// default of 64. Unused for every other type.
	MaxItems int
}

// Operation is a single registry entry.
type Operation struct {
	Name        string
	Description string
	// TimeoutSeconds bounds a single execution. Every operation has one; there
	// is no "unlimited" option.
	TimeoutSeconds int
	Params         []ParamSpec
	Handler        Handler
}

// ErrUnknownOperation is returned when a name is not in the registry.
var ErrUnknownOperation = errors.New("unknown operation")

// Registry is an immutable lookup table.
type Registry struct {
	operations map[string]Operation
}

// New builds a registry from the given operations, rejecting duplicates.
func New(operations ...Operation) (*Registry, error) {
	table := make(map[string]Operation, len(operations))
	for _, op := range operations {
		if op.Name == "" {
			return nil, errors.New("operation name must not be empty")
		}
		if op.Handler == nil {
			return nil, fmt.Errorf("operation %q has no handler", op.Name)
		}
		if op.TimeoutSeconds <= 0 {
			return nil, fmt.Errorf("operation %q must declare a positive timeout", op.Name)
		}
		if _, exists := table[op.Name]; exists {
			return nil, fmt.Errorf("operation %q is registered twice", op.Name)
		}
		table[op.Name] = op
	}
	return &Registry{operations: table}, nil
}

// Lookup returns the operation with the given name.
//
// The comparison is an exact map lookup on the caller-supplied string. No
// prefix matching, no case folding, no normalisation — anything not spelled
// exactly as registered is unknown.
func (r *Registry) Lookup(name string) (Operation, error) {
	op, ok := r.operations[name]
	if !ok {
		return Operation{}, ErrUnknownOperation
	}
	return op, nil
}

// Names returns the registered operation names in sorted order.
func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.operations))
	for name := range r.operations {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ValidateParams checks raw JSON parameters against an operation's schema.
//
// The schema is a strict allowlist: any key not declared by the operation is a
// hard error rather than being ignored. Silently dropping unknown keys would
// mean a caller could not tell the difference between "this parameter was
// applied" and "this parameter was discarded".
func ValidateParams(op Operation, raw json.RawMessage) (map[string]any, error) {
	params := map[string]any{}

	if len(raw) > 0 {
		decoder := json.NewDecoder(newLimitedReader(raw))
		// Reject numbers that cannot round-trip through float64.
		decoder.UseNumber()
		if err := decoder.Decode(&params); err != nil {
			return nil, fmt.Errorf("params must be a JSON object: %w", err)
		}
		if decoder.More() {
			return nil, errors.New("params contains trailing data")
		}
		// JSON `null` decodes into a nil map without error. It means "no
		// parameters", which is legitimate, but the rest of this function and
		// every handler expect a usable map — so it is normalised here rather
		// than leaving a nil to be discovered later.
		if params == nil {
			params = map[string]any{}
		}
	}

	allowed := make(map[string]ParamSpec, len(op.Params))
	for _, spec := range op.Params {
		allowed[spec.Name] = spec
	}

	for key, value := range params {
		spec, ok := allowed[key]
		if !ok {
			return nil, fmt.Errorf("unknown parameter %q", key)
		}
		if err := checkType(spec, value); err != nil {
			return nil, err
		}
	}

	for _, spec := range op.Params {
		if spec.Required {
			if _, present := params[spec.Name]; !present {
				return nil, fmt.Errorf("missing required parameter %q", spec.Name)
			}
		}
	}

	return params, nil
}

func checkType(spec ParamSpec, value any) error {
	switch spec.Type {
	case "string":
		s, ok := value.(string)
		if !ok {
			return fmt.Errorf("parameter %q must be a string", spec.Name)
		}
		max := spec.MaxLength
		if max == 0 {
			max = 256
		}
		if len(s) > max {
			return fmt.Errorf("parameter %q exceeds %d characters", spec.Name, max)
		}
	case "bool":
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("parameter %q must be a boolean", spec.Name)
		}
	case "number":
		if _, ok := value.(json.Number); !ok {
			return fmt.Errorf("parameter %q must be a number", spec.Name)
		}
	case "string[]":
		items, ok := value.([]any)
		if !ok {
			return fmt.Errorf("parameter %q must be an array of strings", spec.Name)
		}
		maxItems := spec.MaxItems
		if maxItems == 0 {
			maxItems = 64
		}
		if len(items) > maxItems {
			return fmt.Errorf("parameter %q exceeds %d items", spec.Name, maxItems)
		}
		maxLen := spec.MaxLength
		if maxLen == 0 {
			maxLen = 256
		}
		for i, item := range items {
			s, ok := item.(string)
			if !ok {
				return fmt.Errorf("parameter %q[%d] must be a string", spec.Name, i)
			}
			if len(s) > maxLen {
				return fmt.Errorf("parameter %q[%d] exceeds %d characters", spec.Name, i, maxLen)
			}
		}
	default:
		return fmt.Errorf("parameter %q has an unsupported declared type %q", spec.Name, spec.Type)
	}
	return nil
}
