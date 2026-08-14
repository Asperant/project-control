package operations

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func testConfig(t *testing.T, allowedRoot string) Config {
	t.Helper()
	return Config{
		WorkingDir:          t.TempDir(),
		SocketPath:          "/run/project-control/runner.sock",
		Version:             "test",
		AllowedProjectRoots: []string{allowedRoot},
	}
}

func TestProjectPathValidateAcceptsAllowedPath(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "demo")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}

	handler := projectPathValidate(testConfig(t, root))
	result, err := handler(context.Background(), map[string]any{"path": project})
	if err != nil {
		t.Fatal(err)
	}
	if result["valid"] != true {
		t.Fatalf("result = %+v, want valid=true", result)
	}
	if result["allowedRoot"] != root {
		t.Fatalf("allowedRoot = %v, want %v", result["allowedRoot"], root)
	}
}

func TestProjectPathValidateRejectsOutsideRoot(t *testing.T) {
	root := t.TempDir()
	elsewhere := t.TempDir()

	handler := projectPathValidate(testConfig(t, root))
	result, err := handler(context.Background(), map[string]any{"path": elsewhere})
	if err != nil {
		t.Fatal(err)
	}
	if result["valid"] != false {
		t.Fatalf("result = %+v, want valid=false", result)
	}
	if result["reason"] != "outside_allowed_roots" {
		t.Fatalf("reason = %v, want outside_allowed_roots", result["reason"])
	}
}

func TestProjectPathValidateWithNoConfiguredRoots(t *testing.T) {
	cfg := Config{WorkingDir: t.TempDir()} // AllowedProjectRoots left nil
	handler := projectPathValidate(cfg)

	result, err := handler(context.Background(), map[string]any{"path": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if result["reason"] != "no_allowed_roots_configured" {
		t.Fatalf("reason = %v, want no_allowed_roots_configured", result["reason"])
	}
}

func TestProjectInspectRejectsOutsideRootWithoutScanning(t *testing.T) {
	root := t.TempDir()
	elsewhere := t.TempDir()
	// A file that would prove a scan happened, if it (incorrectly) did.
	if err := os.WriteFile(filepath.Join(elsewhere, "package.json"), []byte(`{"dependencies":{"react":"^18"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	handler := projectInspect(testConfig(t, root))
	result, err := handler(context.Background(), map[string]any{"path": elsewhere})
	if err != nil {
		t.Fatal(err)
	}
	if result["valid"] != false {
		t.Fatalf("result = %+v, want valid=false", result)
	}
	if _, present := result["technologies"]; present {
		t.Fatal("an invalid path must never be scanned for technology")
	}
}

func TestProjectInspectReturnsDetectedTechnology(t *testing.T) {
	root := t.TempDir()
	project := filepath.Join(root, "demo")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "package.json"), []byte(`{"dependencies":{"react":"^18"}}`), 0o644); err != nil {
		t.Fatal(err)
	}

	handler := projectInspect(testConfig(t, root))
	result, err := handler(context.Background(), map[string]any{"path": project})
	if err != nil {
		t.Fatal(err)
	}
	if result["valid"] != true {
		t.Fatalf("result = %+v, want valid=true", result)
	}
	techs, ok := result["technologies"].([]any)
	if !ok || len(techs) == 0 {
		t.Fatalf("technologies = %+v, want at least one entry", result["technologies"])
	}
	if result["scanVersion"] != scanVersion {
		t.Fatalf("scanVersion = %v, want %v", result["scanVersion"], scanVersion)
	}
}

func TestValidationReasonMapsKnownErrors(t *testing.T) {
	root := t.TempDir()
	cases := map[string]string{
		root:                     "is_allowed_root",
		filepath.Join(root, "x"): "not_found",
	}
	handler := projectPathValidate(testConfig(t, root))
	for input, wantReason := range cases {
		result, err := handler(context.Background(), map[string]any{"path": input})
		if err != nil {
			t.Fatal(err)
		}
		if result["reason"] != wantReason {
			t.Errorf("path %q: reason = %v, want %v", input, result["reason"], wantReason)
		}
	}
}
