// Package projectpath validates a caller-supplied project folder path against
// a fixed, root-owned list of allowed roots.
//
// This is the single gate every project-registration operation passes
// through before touching the filesystem. It is deliberately the only place
// this logic exists: every other package that needs "is this path safe to
// read" calls Validate rather than re-implementing any part of it.
package projectpath

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

// Result is a validated, canonical project path.
type Result struct {
	// Canonical is the fully resolved path (all symlinks followed), guaranteed
	// to exist, be a directory, and lie strictly inside Root.
	Canonical string
	// Root is the allowed root Canonical was found under.
	Root string
}

var (
	ErrMalformed           = errors.New("path is empty, not valid UTF-8, or contains a null byte")
	ErrNotAbsolute         = errors.New("path must be an absolute path")
	ErrTraversal           = errors.New(`path must not contain a ".." segment`)
	ErrNotFound            = errors.New("path does not exist or is not accessible")
	ErrNotDirectory        = errors.New("path is not a directory")
	ErrIsAllowedRootItself = errors.New("the allowed root itself cannot be registered as a project")
	ErrOutsideAllowedRoot  = errors.New("path is not inside any allowed project root")
	ErrNoAllowedRoots      = errors.New("no allowed project roots are configured")
	ErrWriteNotEnabled     = errors.New("this project is not on the write-enabled list")
)

// LoadAllowedRoots reads one absolute directory path per line from path.
// Blank lines and lines starting with '#' are ignored. Duplicate roots (after
// symlink resolution) collapse to one entry.
//
// A root that cannot currently be resolved (e.g. an unmounted drive) is kept
// in cleaned-but-unresolved form rather than dropped or treated as fatal: the
// runner should still start, and Validate will correctly reject anything
// claiming to be under it until the path exists again.
func LoadAllowedRoots(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read allowed project roots file %s: %w", path, err)
	}

	seen := make(map[string]bool)
	var roots []string

	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !filepath.IsAbs(line) {
			return nil, fmt.Errorf("allowed project root %q is not an absolute path", line)
		}
		canonical, evalErr := filepath.EvalSymlinks(line)
		if evalErr != nil {
			canonical = filepath.Clean(line)
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		roots = append(roots, canonical)
	}

	if len(roots) == 0 {
		return nil, fmt.Errorf("allowed project roots file %s contains no entries", path)
	}
	return roots, nil
}

// LoadWriteEnabledProjects reads one absolute project directory path per line
// from path — the opt-in list of projects on which a mutating operation may
// ever be attempted. Format mirrors LoadAllowedRoots (blank lines and '#'
// comments ignored, symlinks resolved, duplicates collapsed), with one
// deliberate difference: an empty list is not an error. The safe, shipped
// default is that no project is write-enabled, so a missing or empty file
// must mean exactly that rather than fail runner start-up.
func LoadWriteEnabledProjects(path string) ([]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("cannot read write-enabled projects file %s: %w", path, err)
	}

	seen := make(map[string]bool)
	var projects []string

	for _, raw := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if !filepath.IsAbs(line) {
			return nil, fmt.Errorf("write-enabled project %q is not an absolute path", line)
		}
		canonical, evalErr := filepath.EvalSymlinks(line)
		if evalErr != nil {
			canonical = filepath.Clean(line)
		}
		if seen[canonical] {
			continue
		}
		seen[canonical] = true
		projects = append(projects, canonical)
	}
	return projects, nil
}

// ValidateWritable applies every Validate check and then additionally
// requires that the resolved path is an exact entry (not merely a
// descendant) of writeEnabled. Exact-match only, deliberately: a prefix match
// here would let enabling writes for one project silently enable writes for
// every directory nested under it.
func ValidateWritable(allowedRoots, writeEnabled []string, rawInput string) (Result, error) {
	result, err := Validate(allowedRoots, rawInput)
	if err != nil {
		return Result{}, err
	}
	for _, project := range writeEnabled {
		if result.Canonical == project {
			return result, nil
		}
	}
	return Result{}, ErrWriteNotEnabled
}

// Validate resolves rawInput against allowedRoots.
//
// Every check here is load-bearing and intentionally layered rather than
// relying on any single one:
//
//  1. The input must be non-empty, valid UTF-8, free of null bytes, absolute,
//     and free of an explicit ".." segment. Clean() below would collapse a
//     ".." on its own, but a request that spells one out is refused outright
//     rather than silently renormalised — the caller's intent was already
//     wrong.
//  2. The path is resolved with EvalSymlinks, which walks and resolves every
//     path component, not just the leaf. This is what makes escaping an
//     allowed root via a symlink — anywhere in the path, including inside the
//     project itself — structurally impossible rather than merely filtered.
//  3. The allowed root itself is never accepted as a project.
//  4. Containment is a component-wise check: canonical == root is rejected by
//     (3), and otherwise canonical must start with root + separator. A bare
//     string-prefix check would let "/home/user/Desktop-evil" be mistaken for
//     a child of "/home/user/Desktop"; the separator makes that impossible.
func Validate(allowedRoots []string, rawInput string) (Result, error) {
	if len(allowedRoots) == 0 {
		return Result{}, ErrNoAllowedRoots
	}
	if rawInput == "" || !utf8.ValidString(rawInput) || strings.ContainsRune(rawInput, 0) {
		return Result{}, ErrMalformed
	}
	if !filepath.IsAbs(rawInput) {
		return Result{}, ErrNotAbsolute
	}
	for _, segment := range strings.Split(rawInput, "/") {
		if segment == ".." {
			return Result{}, ErrTraversal
		}
	}

	cleaned := filepath.Clean(rawInput)

	canonical, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		return Result{}, ErrNotFound
	}

	info, err := os.Stat(canonical)
	if err != nil {
		return Result{}, ErrNotFound
	}
	if !info.IsDir() {
		return Result{}, ErrNotDirectory
	}

	for _, root := range allowedRoots {
		if canonical == root {
			return Result{}, ErrIsAllowedRootItself
		}
		if strings.HasPrefix(canonical, root+string(os.PathSeparator)) {
			return Result{Canonical: canonical, Root: root}, nil
		}
	}
	return Result{}, ErrOutsideAllowedRoot
}

// WithinRoot reports whether candidate (assumed already canonical/resolved)
// lies strictly inside root, using the same component-wise rule as Validate.
// Used while walking a project directory to confirm a resolved child path —
// including one reached through a symlink the walker chose to resolve —
// never escaped the project root.
func WithinRoot(root, candidate string) bool {
	return candidate != root && strings.HasPrefix(candidate, root+string(os.PathSeparator))
}
