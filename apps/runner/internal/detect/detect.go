// Package detect identifies technologies, manifests and command metadata for
// a project by reading a small, fixed allowlist of well-known project
// definition files.
//
// It never imports, evaluates or executes any project code, and never reads a
// file whose name is not on the allowlist below — which is what keeps a
// secret file (.env, an SSH key, a credentials file) structurally out of
// reach: there is no path through this package that opens a file by any name
// other than one of the literal manifest names or suffix/prefix patterns
// matched in matchManifest.
package detect

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Technology is one detected (or, at the API layer, user-added) technology.
type Technology struct {
	Name         string
	Category     string
	Version      string
	EvidencePath string
}

// Command is one detected test/lint/build/... command definition. Metadata
// only: CommandText is never parsed as argv and never executed by any part of
// this platform.
type Command struct {
	Type             string
	DisplayName      string
	CommandText      string
	WorkingDirectory string
	EvidencePath     string
}

// Result is everything a scan produced.
type Result struct {
	Manifests    []string
	Technologies []Technology
	Commands     []Command
	Warnings     []string
	LimitsHit    []string
}

// Limits bounds a scan. Every field has a conservative default; a caller
// exposing this to an admin-triggered HTTP action should not need to raise
// any of them.
type Limits struct {
	MaxDepth         int
	MaxDirectories   int
	MaxFilesListed   int
	MaxManifestFiles int
	MaxFileBytes     int64
	MaxWarnings      int
}

// DefaultLimits covers a typical repository, including a shallow monorepo
// layout (root, then one directory of packages, then each package's own
// manifest), without approaching pathological cost on a directory tree an
// operator did not expect to be large.
func DefaultLimits() Limits {
	return Limits{
		MaxDepth:         2,
		MaxDirectories:   2000,
		MaxFilesListed:   20000,
		MaxManifestFiles: 300,
		MaxFileBytes:     512 * 1024,
		MaxWarnings:      50,
	}
}

// skipDirNames are never descended into: dependency/build/cache output, VCS
// internals, and editor state. None of these can contain a project
// definition file that is not itself a copy of one already found elsewhere.
var skipDirNames = map[string]bool{
	"node_modules": true, "vendor": true, ".git": true, ".hg": true, ".svn": true,
	"venv": true, ".venv": true, "env": true, "__pycache__": true,
	"dist": true, "build": true, "out": true,
	".next": true, ".nuxt": true, ".turbo": true, ".svelte-kit": true,
	"coverage": true, "target": true, "bin": true, "obj": true,
	".idea": true, ".vscode": true, ".cache": true, "tmp": true, ".tmp": true,
	".pytest_cache": true, ".mypy_cache": true, ".ruff_cache": true, ".tox": true,
}

type scanState struct {
	dirCount      int
	fileCount     int
	manifestCount int
	techSeen      map[string]bool
	cmdSeen       map[string]bool
	limitsHit     map[string]bool
}

// Scan walks root (which must already be validated by projectpath.Validate)
// looking for known project-definition files, up to Limits.MaxDepth
// directory levels deep, and returns the technologies and command metadata
// they are evidence for.
func Scan(ctx context.Context, root string, limits Limits) (Result, error) {
	result := Result{}
	state := &scanState{
		techSeen:  map[string]bool{},
		cmdSeen:   map[string]bool{},
		limitsHit: map[string]bool{},
	}

	if err := walk(ctx, root, ".", 0, limits, state, &result); err != nil {
		return result, err
	}

	sort.Slice(result.Technologies, func(i, j int) bool {
		if result.Technologies[i].Category != result.Technologies[j].Category {
			return result.Technologies[i].Category < result.Technologies[j].Category
		}
		return result.Technologies[i].Name < result.Technologies[j].Name
	})
	sort.Strings(result.Manifests)

	for hit := range state.limitsHit {
		result.LimitsHit = append(result.LimitsHit, hit)
	}
	sort.Strings(result.LimitsHit)

	return result, nil
}

func walk(ctx context.Context, dirAbs, dirRel string, depth int, limits Limits, state *scanState, result *Result) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	state.dirCount++
	if state.dirCount > limits.MaxDirectories {
		addLimitHit(state, result, "max_directories_scanned")
		return nil
	}

	entries, err := os.ReadDir(dirAbs)
	if err != nil {
		addWarning(state, result, limits, fmt.Sprintf("could not read %s", displayRel(dirRel)))
		return nil
	}

	var subdirs []os.DirEntry
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if state.fileCount > limits.MaxFilesListed {
			addLimitHit(state, result, "max_files_listed")
			break
		}

		name := entry.Name()

		if entry.IsDir() {
			// DirEntry.IsDir() reflects the entry itself (lstat semantics): a
			// symlink to a directory reports IsDir()=false here, so it is never
			// added to subdirs and is therefore never followed.
			if skipDirNames[name] {
				continue
			}
			subdirs = append(subdirs, entry)
			continue
		}

		entryType := entry.Type()
		if entryType&os.ModeSymlink != 0 {
			continue // never follow a symlinked file either
		}
		if !entryType.IsRegular() {
			continue // FIFOs, sockets, devices, etc. are never read
		}

		state.fileCount++
		if matched, kind := matchManifest(name); matched {
			considerManifest(dirAbs, dirRel, name, kind, limits, state, result)
		}
	}

	if depth >= limits.MaxDepth {
		return nil
	}
	for _, sd := range subdirs {
		childAbs := filepath.Join(dirAbs, sd.Name())
		childRel := path.Join(dirRel, sd.Name())
		if err := walk(ctx, childAbs, childRel, depth+1, limits, state, result); err != nil {
			return err
		}
	}
	return nil
}

func addLimitHit(state *scanState, result *Result, reason string) {
	if state.limitsHit[reason] {
		return
	}
	state.limitsHit[reason] = true
	_ = result // LimitsHit is populated from state.limitsHit at the end of Scan
}

func addWarning(state *scanState, result *Result, limits Limits, message string) {
	if len(result.Warnings) >= limits.MaxWarnings {
		return
	}
	result.Warnings = append(result.Warnings, message)
}

// displayRel never leaks anything beyond the project-relative path — no
// absolute host path, no parent directory names.
func displayRel(rel string) string {
	if rel == "." || rel == "" {
		return "."
	}
	return rel
}

func considerManifest(dirAbs, dirRel, filename, kind string, limits Limits, state *scanState, result *Result) {
	if state.manifestCount >= limits.MaxManifestFiles {
		addLimitHit(state, result, "max_manifest_files_read")
		return
	}

	fullPath := filepath.Join(dirAbs, filename)
	info, err := os.Lstat(fullPath)
	if err != nil {
		return
	}
	// Belt and suspenders: the walker already filters entries by type before
	// calling this function, but the manifest is re-stat'd by name here
	// (TOCTOU-safe enough for a read-only, single-admin-triggered scan) and
	// re-checked, since this is the function that actually opens the file.
	if info.Mode()&os.ModeSymlink != 0 || !info.Mode().IsRegular() {
		return
	}

	relPath := displayRel(path.Join(dirRel, filename))
	result.Manifests = append(result.Manifests, relPath)
	state.manifestCount++

	if info.Size() > limits.MaxFileBytes {
		addWarning(state, result, limits, fmt.Sprintf("%s exceeds the size limit and was not read", relPath))
		addLimitHit(state, result, "max_manifest_file_bytes")
		return
	}
	if info.Size() == 0 {
		return
	}

	data, err := os.ReadFile(fullPath)
	if err != nil {
		addWarning(state, result, limits, fmt.Sprintf("%s could not be read", relPath))
		return
	}
	if int64(len(data)) > limits.MaxFileBytes {
		data = data[:limits.MaxFileBytes]
	}

	parseManifest(kind, relPath, displayRel(dirRel), data, limits, state, result)
}

// matchManifest reports whether name is a recognised project-definition
// file, and which parser handles it. This is an allowlist: any file not
// matched here is never opened, which is the structural guarantee that a
// secret file is never read regardless of what it is named.
func matchManifest(name string) (bool, string) {
	switch name {
	case "package.json":
		return true, "package.json"
	case "pnpm-lock.yaml":
		return true, "pnpm-lock.yaml"
	case "package-lock.json":
		return true, "package-lock.json"
	case "yarn.lock":
		return true, "yarn.lock"
	case "bun.lock", "bun.lockb":
		return true, "bun.lock"
	case "pnpm-workspace.yaml":
		return true, "pnpm-workspace"
	case "pyproject.toml":
		return true, "pyproject.toml"
	case "requirements.txt":
		return true, "requirements.txt"
	case "Pipfile":
		return true, "pipfile"
	case "poetry.lock":
		return true, "poetry.lock"
	case "uv.lock":
		return true, "uv.lock"
	case "go.mod":
		return true, "go.mod"
	case "Cargo.toml":
		return true, "cargo.toml"
	case "pom.xml":
		return true, "pom.xml"
	case "build.gradle", "build.gradle.kts":
		return true, "gradle"
	case "Dockerfile":
		return true, "dockerfile"
	case "compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml":
		return true, "compose"
	case "Makefile", "makefile", "GNUmakefile":
		return true, "makefile"
	case "tsconfig.json":
		return true, "tsconfig"
	case "pytest.ini":
		return true, "pytest.ini"
	}
	switch {
	case strings.HasSuffix(name, ".csproj"):
		return true, "csproj"
	case strings.HasSuffix(name, ".sln"):
		return true, "sln"
	case strings.HasPrefix(name, "vite.config."):
		return true, "vite.config"
	case strings.HasPrefix(name, "next.config."):
		return true, "next.config"
	case strings.HasPrefix(name, "jest.config."):
		return true, "jest.config"
	case strings.HasPrefix(name, "vitest.config."):
		return true, "vitest.config"
	case strings.HasPrefix(name, "playwright.config."):
		return true, "playwright.config"
	case name == ".eslintrc" || strings.HasPrefix(name, ".eslintrc."):
		return true, "eslint"
	case strings.HasPrefix(name, "eslint.config."):
		return true, "eslint"
	}
	return false, ""
}

func addTech(state *scanState, result *Result, name, category, version, evidence string) {
	key := category + "\x00" + strings.ToLower(name)
	if state.techSeen[key] {
		return
	}
	state.techSeen[key] = true
	result.Technologies = append(result.Technologies, Technology{
		Name: name, Category: category, Version: version, EvidencePath: evidence,
	})
}

func addCommand(state *scanState, result *Result, cmdType, displayName, commandText, workingDir, evidence string) {
	key := cmdType + "\x00" + workingDir + "\x00" + commandText
	if state.cmdSeen[key] {
		return
	}
	state.cmdSeen[key] = true
	result.Commands = append(result.Commands, Command{
		Type: cmdType, DisplayName: displayName, CommandText: commandText,
		WorkingDirectory: workingDir, EvidencePath: evidence,
	})
}

// knownCommandType maps a script/target name (from package.json "scripts" or
// a Makefile target) to one of the closed set of command types this platform
// records. Anything not in this map is not captured — Stage scope is a fixed,
// recognisable set, not every script a project happens to define.
func knownCommandType(name string) (string, bool) {
	switch name {
	case "test":
		return "test", true
	case "lint":
		return "lint", true
	case "build":
		return "build", true
	case "typecheck", "type-check", "check-types":
		return "typecheck", true
	case "validate":
		return "validate", true
	}
	return "", false
}

func mergeDeps(maps ...map[string]string) map[string]string {
	out := map[string]string{}
	for _, m := range maps {
		for k, v := range m {
			out[k] = v
		}
	}
	return out
}

// packageManagerFieldPattern parses package.json's "packageManager" field,
// e.g. "pnpm@9.1.0".
var packageManagerFieldPattern = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9_-]*)@([0-9][0-9A-Za-z.+-]*)`)

func parsePackageManagerField(value string) (name, version string, ok bool) {
	m := packageManagerFieldPattern.FindStringSubmatch(value)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

var goModVersionPattern = regexp.MustCompile(`(?m)^go\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?)`)

func goModVersion(data []byte) string {
	m := goModVersionPattern.FindSubmatch(data)
	if m == nil {
		return ""
	}
	return string(m[1])
}

func splitRequirementName(line string) string {
	cut := strings.IndexAny(line, "=<>!~[; \t")
	if cut == -1 {
		return line
	}
	return line[:cut]
}

var composeImagePattern = regexp.MustCompile(`(?im)^\s*image:\s*["']?([a-zA-Z0-9_./:-]+)`)
var makeTargetPattern = regexp.MustCompile(`(?m)^([A-Za-z0-9_.-]+)\s*:(?:[^=]|$)`)

func parseManifest(kind, relPath, dirRel string, data []byte, limits Limits, state *scanState, result *Result) {
	switch kind {
	case "package.json":
		parsePackageJSON(relPath, dirRel, data, limits, state, result)

	case "pnpm-lock.yaml":
		addTech(state, result, "pnpm", "package_manager", "", relPath)
	case "yarn.lock":
		addTech(state, result, "Yarn", "package_manager", "", relPath)
	case "package-lock.json":
		addTech(state, result, "npm", "package_manager", "", relPath)
	case "bun.lock":
		addTech(state, result, "Bun", "package_manager", "", relPath)
	case "pnpm-workspace":
		addTech(state, result, "Monorepo (pnpm workspace)", "monorepo", "", relPath)

	case "go.mod":
		addTech(state, result, "Go", "language", goModVersion(data), relPath)

	case "requirements.txt":
		addTech(state, result, "Python", "language", "", relPath)
		addTech(state, result, "pip", "package_manager", "", relPath)
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "-") {
				continue
			}
			name := strings.ToLower(splitRequirementName(line))
			if tech, ok := pyPackageTechnology[name]; ok {
				addTech(state, result, tech.Name, tech.Category, "", relPath)
			}
		}

	case "pyproject.toml":
		addTech(state, result, "Python", "language", "", relPath)
		text := strings.ToLower(string(data))
		if strings.Contains(text, "[tool.poetry]") {
			addTech(state, result, "Poetry", "package_manager", "", relPath)
		}
		if strings.Contains(text, "[tool.pytest") {
			addTech(state, result, "pytest", "test_tool", "", relPath)
		}
		for pkgName, tech := range pyPackageTechnology {
			if strings.Contains(text, pkgName) {
				addTech(state, result, tech.Name, tech.Category, "", relPath)
			}
		}

	case "pipfile":
		addTech(state, result, "Python", "language", "", relPath)
		addTech(state, result, "pipenv", "package_manager", "", relPath)
	case "poetry.lock":
		addTech(state, result, "Python", "language", "", relPath)
		addTech(state, result, "Poetry", "package_manager", "", relPath)
	case "uv.lock":
		addTech(state, result, "Python", "language", "", relPath)
		addTech(state, result, "uv", "package_manager", "", relPath)

	case "cargo.toml":
		addTech(state, result, "Rust", "language", "", relPath)
		addTech(state, result, "Cargo", "package_manager", "", relPath)

	case "pom.xml":
		addTech(state, result, "Java", "language", "", relPath)
		addTech(state, result, "Maven", "build_tool", "", relPath)

	case "gradle":
		addTech(state, result, "Java/Kotlin", "language", "", relPath)
		addTech(state, result, "Gradle", "build_tool", "", relPath)

	case "dockerfile":
		addTech(state, result, "Docker", "container", "", relPath)

	case "compose":
		addTech(state, result, "Docker Compose", "container", "", relPath)
		for _, m := range composeImagePattern.FindAllSubmatch(data, -1) {
			img := strings.ToLower(string(m[1]))
			for key, techName := range composeImageDatabase {
				if strings.Contains(img, key) {
					addTech(state, result, techName, "database", "", relPath)
					break
				}
			}
		}

	case "makefile":
		addTech(state, result, "Make", "build_tool", "", relPath)
		for _, m := range makeTargetPattern.FindAllSubmatch(data, -1) {
			target := string(m[1])
			if target == ".PHONY" {
				continue
			}
			if cmdType, ok := knownCommandType(target); ok {
				addCommand(state, result, cmdType, target, "make "+target, dirRel, relPath)
			}
		}

	case "tsconfig":
		addTech(state, result, "TypeScript", "language", "", relPath)
	case "eslint":
		addTech(state, result, "ESLint", "other", "", relPath)
	case "vite.config":
		addTech(state, result, "Vite", "build_tool", "", relPath)
	case "next.config":
		addTech(state, result, "Next.js", "framework", "", relPath)
	case "jest.config":
		addTech(state, result, "Jest", "test_tool", "", relPath)
	case "vitest.config":
		addTech(state, result, "Vitest", "test_tool", "", relPath)
	case "playwright.config":
		addTech(state, result, "Playwright", "test_tool", "", relPath)
	case "pytest.ini":
		addTech(state, result, "Python", "language", "", relPath)
		addTech(state, result, "pytest", "test_tool", "", relPath)
	case "csproj", "sln":
		addTech(state, result, "C#/.NET", "language", "", relPath)
		addTech(state, result, ".NET SDK", "build_tool", "", relPath)
	}
}

func parsePackageJSON(relPath, dirRel string, data []byte, limits Limits, state *scanState, result *Result) {
	var pkg struct {
		PackageManager  string            `json:"packageManager"`
		Dependencies    map[string]string `json:"dependencies"`
		DevDependencies map[string]string `json:"devDependencies"`
		Scripts         map[string]string `json:"scripts"`
		Workspaces      json.RawMessage   `json:"workspaces"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		addWarning(state, result, limits, fmt.Sprintf("%s is not valid JSON and was skipped", relPath))
		return
	}

	addTech(state, result, "JavaScript/TypeScript", "language", "", relPath)

	deps := mergeDeps(pkg.Dependencies, pkg.DevDependencies)
	for name := range deps {
		if tech, ok := npmDependencyTechnology[strings.ToLower(name)]; ok {
			addTech(state, result, tech.Name, tech.Category, "", relPath)
		}
	}
	if version, ok := deps["typescript"]; ok {
		addTech(state, result, "TypeScript", "language", version, relPath)
	}

	if pkg.PackageManager != "" {
		if name, version, ok := parsePackageManagerField(pkg.PackageManager); ok {
			addTech(state, result, name, "package_manager", version, relPath)
		}
	}

	if len(pkg.Workspaces) > 0 && string(pkg.Workspaces) != "null" {
		addTech(state, result, "Monorepo (npm/yarn workspaces)", "monorepo", "", relPath)
	}

	for scriptName, scriptCmd := range pkg.Scripts {
		if cmdType, ok := knownCommandType(scriptName); ok {
			addCommand(state, result, cmdType, scriptName, scriptCmd, dirRel, relPath)
		}
	}
}
