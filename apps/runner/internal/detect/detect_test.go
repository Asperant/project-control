package detect

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func mkfifoOrSkip(t *testing.T, path string) error {
	t.Helper()
	return syscall.Mkfifo(path, 0o644)
}

func mustWrite(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func findTech(result Result, name, category string) (Technology, bool) {
	for _, tech := range result.Technologies {
		if tech.Name == name && tech.Category == category {
			return tech, true
		}
	}
	return Technology{}, false
}

func TestScanDetectsNodeProject(t *testing.T) {
	root := t.TempDir()
	pkg := map[string]any{
		"name":    "demo",
		"version": "1.0.0",
		"scripts": map[string]string{
			"test":  "vitest run",
			"build": "vite build",
			"lint":  "eslint .",
			"dev":   "vite",
		},
		"dependencies":    map[string]string{"react": "^18.0.0", "fastify": "^4.0.0", "pg": "^8.0.0"},
		"devDependencies": map[string]string{"typescript": "^5.0.0", "vitest": "^1.0.0", "vite": "^5.0.0"},
	}
	data, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	mustWrite(t, filepath.Join(root, "package.json"), string(data))
	mustWrite(t, filepath.Join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
	mustWrite(t, filepath.Join(root, "tsconfig.json"), "{}\n")

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}

	for _, want := range []struct{ name, category string }{
		{"JavaScript/TypeScript", "language"},
		{"TypeScript", "language"},
		{"React", "framework"},
		{"Fastify", "framework"},
		{"PostgreSQL", "database"},
		{"Vite", "build_tool"},
		{"Vitest", "test_tool"},
		{"pnpm", "package_manager"},
	} {
		if _, ok := findTech(result, want.name, want.category); !ok {
			t.Errorf("expected technology %s/%s, got %+v", want.name, want.category, result.Technologies)
		}
	}

	// TypeScript from tsconfig.json must not duplicate the one from
	// devDependencies.
	count := 0
	for _, tech := range result.Technologies {
		if tech.Name == "TypeScript" && tech.Category == "language" {
			count++
		}
	}
	if count != 1 {
		t.Errorf("TypeScript recorded %d times, want 1 (deduplicated)", count)
	}

	wantCommands := map[string]string{"test": "vitest run", "build": "vite build", "lint": "eslint ."}
	if len(result.Commands) != len(wantCommands) {
		t.Fatalf("commands = %+v, want exactly %v (no 'dev' script — not a recognised type)", result.Commands, wantCommands)
	}
	for _, cmd := range result.Commands {
		if wantCommands[cmd.Type] != cmd.CommandText {
			t.Errorf("command %s = %q, want %q", cmd.Type, cmd.CommandText, wantCommands[cmd.Type])
		}
	}
}

func TestScanDetectsPythonProject(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "requirements.txt"), "Django==5.0.1\npsycopg2-binary>=2.9\npytest\n# a comment\n")

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct{ name, category string }{
		{"Python", "language"},
		{"pip", "package_manager"},
	} {
		if _, ok := findTech(result, want.name, want.category); !ok {
			t.Errorf("expected %s/%s, got %+v", want.name, want.category, result.Technologies)
		}
	}
	// "Django==5.0.1" must match despite the version pin.
	if _, ok := findTech(result, "Django", "framework"); !ok {
		t.Errorf("expected Django to be detected despite version pin, got %+v", result.Technologies)
	}
	if _, ok := findTech(result, "PostgreSQL", "database"); !ok {
		t.Errorf("expected PostgreSQL from psycopg2-binary, got %+v", result.Technologies)
	}
}

func TestScanDetectsGoModule(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "go.mod"), "module example.com/demo\n\ngo 1.26\n")

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	tech, ok := findTech(result, "Go", "language")
	if !ok {
		t.Fatalf("expected Go language technology, got %+v", result.Technologies)
	}
	if tech.Version != "1.26" {
		t.Errorf("Go version = %q, want 1.26", tech.Version)
	}
}

func TestScanDetectsMonorepoLayout(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n")
	mustWrite(t, filepath.Join(root, "apps", "web", "package.json"), `{"name":"web","dependencies":{"react":"^18"}}`)

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := findTech(result, "Monorepo (pnpm workspace)", "monorepo"); !ok {
		t.Errorf("expected monorepo technology, got %+v", result.Technologies)
	}
	if _, ok := findTech(result, "React", "framework"); !ok {
		t.Errorf("expected React detected from apps/web/package.json (depth 2), got %+v", result.Technologies)
	}
}

func TestScanNeverReadsSecretFiles(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, ".env"), "DATABASE_PASSWORD=supersecret\n")
	mustWrite(t, filepath.Join(root, "id_rsa"), "-----BEGIN OPENSSH PRIVATE KEY-----\nnotreal\n-----END OPENSSH PRIVATE KEY-----\n")
	mustWrite(t, filepath.Join(root, "credentials.json"), `{"token":"supersecret"}`)
	mustWrite(t, filepath.Join(root, "package.json"), `{"name":"demo"}`)

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range result.Manifests {
		if strings.Contains(m, ".env") || strings.Contains(m, "id_rsa") || strings.Contains(m, "credentials") {
			t.Fatalf("a secret-shaped file was treated as a manifest: %s", m)
		}
	}
	if len(result.Manifests) != 1 || result.Manifests[0] != "package.json" {
		t.Fatalf("manifests = %v, want only package.json", result.Manifests)
	}
}

func TestScanSkipsHeavyDirectories(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "node_modules", "some-pkg", "package.json"), `{"name":"nested"}`)
	mustWrite(t, filepath.Join(root, ".git", "config"), "[core]\n")
	mustWrite(t, filepath.Join(root, "package.json"), `{"name":"root"}`)

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Manifests) != 1 {
		t.Fatalf("manifests = %v, want only the root package.json (node_modules/.git must be skipped)", result.Manifests)
	}
}

func TestScanDoesNotFollowSymlinkedDirectory(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, ".env"), "SECRET=1\n")
	mustWrite(t, filepath.Join(outside, "package.json"), `{"name":"outside"}`)

	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Manifests) != 0 {
		t.Fatalf("expected no manifests (symlinked directory must not be followed), got %v", result.Manifests)
	}
}

func TestScanDoesNotReadSymlinkedFile(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	mustWrite(t, filepath.Join(outside, "real-package.json"), `{"name":"outside","dependencies":{"react":"^18"}}`)

	if err := os.Symlink(filepath.Join(outside, "real-package.json"), filepath.Join(root, "package.json")); err != nil {
		t.Fatal(err)
	}

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Manifests) != 0 {
		t.Fatalf("expected the symlinked manifest to be skipped entirely, got %v", result.Manifests)
	}
	if _, ok := findTech(result, "React", "framework"); ok {
		t.Fatal("technology from a symlinked manifest must not be detected")
	}
}

func TestScanDoesNotReadSpecialFiles(t *testing.T) {
	if os.Getenv("CI") != "" {
		t.Skip("mkfifo may be unavailable in the CI sandbox")
	}
	root := t.TempDir()
	fifoPath := filepath.Join(root, "package.json")
	// mkfifo via syscall to avoid a dependency on the `mkfifo` binary being on
	// PATH inside the test sandbox.
	if err := mkfifoOrSkip(t, fifoPath); err != nil {
		t.Skip("mkfifo not supported in this environment")
	}

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Manifests) != 0 {
		t.Fatalf("a FIFO named package.json must never be read, got %v", result.Manifests)
	}
}

func TestScanRespectsMaxDepth(t *testing.T) {
	root := t.TempDir()
	// depth 3 relative to root: a/b/c/package.json — beyond DefaultLimits().MaxDepth (2)
	mustWrite(t, filepath.Join(root, "a", "b", "c", "package.json"), `{"name":"deep"}`)

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Manifests) != 0 {
		t.Fatalf("manifest beyond MaxDepth must not be found, got %v", result.Manifests)
	}
}

func TestScanDetectsDockerCompose(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "docker-compose.yml"), "services:\n  db:\n    image: postgres:16\n  cache:\n    image: redis:7\n")

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := findTech(result, "Docker Compose", "container"); !ok {
		t.Error("expected Docker Compose technology")
	}
	if _, ok := findTech(result, "PostgreSQL", "database"); !ok {
		t.Error("expected PostgreSQL detected from compose image")
	}
	if _, ok := findTech(result, "Redis", "database"); !ok {
		t.Error("expected Redis detected from compose image")
	}
}

func TestScanDetectsMakefileTargets(t *testing.T) {
	root := t.TempDir()
	mustWrite(t, filepath.Join(root, "Makefile"), ".PHONY: test build\n\ntest:\n\tgo test ./...\n\nbuild:\n\tgo build ./...\n")

	result, err := Scan(context.Background(), root, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := findTech(result, "Make", "build_tool"); !ok {
		t.Error("expected Make technology")
	}
	found := map[string]string{}
	for _, cmd := range result.Commands {
		found[cmd.Type] = cmd.CommandText
	}
	if found["test"] != "make test" || found["build"] != "make build" {
		t.Fatalf("commands = %v, want test=make test, build=make build", found)
	}
}
