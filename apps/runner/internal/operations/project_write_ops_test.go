package operations

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/project-control/runner/internal/registry"
)

func testWritableConfig(t *testing.T, allowedRoot, writeEnabledProject string) Config {
	t.Helper()
	cfg := testConfig(t, allowedRoot)
	if writeEnabledProject != "" {
		cfg.WriteEnabledProjects = []string{writeEnabledProject}
	}
	return cfg
}

func initWritableRepo(t *testing.T, root string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git binary not available")
	}
	project := filepath.Join(root, "demo")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = project
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	run("config", "user.email", "owner@example.com")
	run("config", "user.name", "Project Owner")
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run("add", "README.md")
	run("commit", "-q", "-m", "initial commit")
	return project
}

func headSHA(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "HEAD")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git rev-parse HEAD: %v\n%s", err, out)
	}
	return string(out[:len(out)-1])
}

// TestProjectGitCommitIsRegisteredWithoutAnyCommandShapedParam is the same
// hostile-payload probe TestProjectGitDevelopmentIsRegisteredWithPathOnly
// runs, applied to the runner's one mutating operation specifically: a
// command, argv, script, working-directory override or environment map must
// be rejected by schema validation before the handler ever runs.
func TestProjectGitCommitIsRegisteredWithoutAnyCommandShapedParam(t *testing.T) {
	root := t.TempDir()
	ops := All(testWritableConfig(t, root, ""))
	reg, err := registry.New(ops...)
	if err != nil {
		t.Fatal(err)
	}
	op, err := reg.Lookup("project.git.commit")
	if err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{
		`{"path":"/tmp/demo","branch":"main","expectedHead":"","message":"x","paths":["a"],"command":"rm -rf /"}`,
		`{"path":"/tmp/demo","branch":"main","expectedHead":"","message":"x","paths":["a"],"args":["--force"]}`,
		`{"path":"/tmp/demo","branch":"main","expectedHead":"","message":"x","paths":["a"],"workingDirectory":"/"}`,
		`{"path":"/tmp/demo","branch":"main","expectedHead":"","message":"x","paths":["a"],"env":{"GIT_CONFIG":"x"}}`,
		`{"path":"/tmp/demo","branch":"main","expectedHead":"","message":"x","paths":["a"],"cwd":"/etc"}`,
		`{"path":"/tmp/demo","branch":"main","expectedHead":"","message":"x","paths":["a"],"force":true}`,
	} {
		if _, err := registry.ValidateParams(op, json.RawMessage(raw)); err == nil {
			t.Fatalf("mutation-shaped extra param accepted: %s", raw)
		}
	}
}

func TestProjectGitWriteStatusRejectsAProjectNotOnTheWriteEnabledList(t *testing.T) {
	root := t.TempDir()
	project := initWritableRepo(t, root)

	// No third argument: WriteEnabledProjects is empty, matching the shipped
	// default posture.
	handler := projectGitWriteStatus(testWritableConfig(t, root, ""))
	result, err := handler(context.Background(), map[string]any{"path": project})
	if err != nil {
		t.Fatal(err)
	}
	if result["valid"] != false || result["reason"] != "write_not_enabled" {
		t.Fatalf("result = %+v, want valid=false reason=write_not_enabled", result)
	}
}

func TestProjectGitWriteStatusReportsReadyForACleanWriteEnabledRepo(t *testing.T) {
	root := t.TempDir()
	project := initWritableRepo(t, root)

	handler := projectGitWriteStatus(testWritableConfig(t, root, project))
	result, err := handler(context.Background(), map[string]any{"path": project})
	if err != nil {
		t.Fatal(err)
	}
	if result["valid"] != true || result["writable"] != true {
		t.Fatalf("result = %+v, want valid=true writable=true", result)
	}
	if result["readyToCommit"] != "" {
		t.Fatalf("readyToCommit = %v, want empty (ready)", result["readyToCommit"])
	}
	preflight, ok := result["preflight"].(map[string]any)
	if !ok {
		t.Fatalf("preflight = %#v", result["preflight"])
	}
	if preflight["branch"] != "main" || preflight["identityConfigured"] != true {
		t.Fatalf("preflight = %+v", preflight)
	}
}

// TestProjectGitCommitRejectsAProjectNotOnTheWriteEnabledList is the
// runner-level enforcement RNR-017 checks live: even a well-formed, otherwise
// legitimate commit request against a project the operator never opted in
// must fail before any git process touches the repository.
func TestProjectGitCommitRejectsAProjectNotOnTheWriteEnabledList(t *testing.T) {
	root := t.TempDir()
	project := initWritableRepo(t, root)
	before := headSHA(t, project)
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	handler := projectGitCommit(testWritableConfig(t, root, "")) // not write-enabled
	result, err := handler(context.Background(), map[string]any{
		"path": project, "branch": "main", "expectedHead": before,
		"message": "feat: x", "paths": []any{"README.md"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["valid"] != false || result["reason"] != "write_not_enabled" {
		t.Fatalf("result = %+v, want valid=false reason=write_not_enabled", result)
	}
	if headSHA(t, project) != before {
		t.Fatal("HEAD moved for a project not on the write-enabled list")
	}
}

func TestProjectGitCommitSucceedsForAWriteEnabledProject(t *testing.T) {
	root := t.TempDir()
	project := initWritableRepo(t, root)
	before := headSHA(t, project)
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	handler := projectGitCommit(testWritableConfig(t, root, project))
	result, err := handler(context.Background(), map[string]any{
		"path": project, "branch": "main", "expectedHead": before,
		"message": "feat: update readme", "paths": []any{"README.md"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["valid"] != true || result["committed"] != true {
		t.Fatalf("result = %+v, want valid=true committed=true", result)
	}
	commit, ok := result["commit"].(map[string]any)
	if !ok {
		t.Fatalf("commit = %#v", result["commit"])
	}
	if commit["sha"] != headSHA(t, project) {
		t.Fatalf("commit sha = %v, want current HEAD %v", commit["sha"], headSHA(t, project))
	}
	if commit["branch"] != "main" {
		t.Fatalf("commit branch = %v, want main", commit["branch"])
	}
}

func TestProjectGitCommitRejectsProtectedPathThroughTheOperationLayer(t *testing.T) {
	root := t.TempDir()
	project := initWritableRepo(t, root)
	before := headSHA(t, project)
	if err := os.WriteFile(filepath.Join(project, ".env"), []byte("SECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	handler := projectGitCommit(testWritableConfig(t, root, project))
	result, err := handler(context.Background(), map[string]any{
		"path": project, "branch": "main", "expectedHead": before,
		"message": "feat: x", "paths": []any{".env"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["valid"] != true || result["committed"] != false || result["reason"] != "protected_path_selected" {
		t.Fatalf("result = %+v, want committed=false reason=protected_path_selected", result)
	}
	if headSHA(t, project) != before {
		t.Fatal("HEAD moved for a rejected protected-path commit")
	}
}

func TestProjectGitCommitRejectsStaleExpectedHead(t *testing.T) {
	root := t.TempDir()
	project := initWritableRepo(t, root)
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	handler := projectGitCommit(testWritableConfig(t, root, project))
	result, err := handler(context.Background(), map[string]any{
		"path": project, "branch": "main", "expectedHead": "0000000000000000000000000000000000000000",
		"message": "feat: x", "paths": []any{"README.md"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["committed"] != false || result["reason"] != "head_moved" {
		t.Fatalf("result = %+v, want committed=false reason=head_moved", result)
	}
}

func TestProjectGitWriteStatusIsRegisteredWithPathAndOptionalPaths(t *testing.T) {
	root := t.TempDir()
	ops := All(testWritableConfig(t, root, ""))
	reg, err := registry.New(ops...)
	if err != nil {
		t.Fatal(err)
	}
	op, err := reg.Lookup("project.git.write.status")
	if err != nil {
		t.Fatal(err)
	}
	if len(op.Params) != 2 {
		t.Fatalf("params = %+v, want exactly 2 (path, paths)", op.Params)
	}
	byName := map[string]registry.ParamSpec{}
	for _, p := range op.Params {
		byName[p.Name] = p
	}
	pathSpec, ok := byName["path"]
	if !ok || pathSpec.Type != "string" || !pathSpec.Required {
		t.Fatalf("path param = %+v, want required string", pathSpec)
	}
	pathsSpec, ok := byName["paths"]
	if !ok || pathsSpec.Type != "string[]" || pathsSpec.Required {
		t.Fatalf("paths param = %+v, want optional string[]", pathsSpec)
	}
}

func TestProjectGitWriteStatusOmitsPathIdentitiesWhenPathsNotRequested(t *testing.T) {
	root := t.TempDir()
	project := initWritableRepo(t, root)

	handler := projectGitWriteStatus(testWritableConfig(t, root, project))
	result, err := handler(context.Background(), map[string]any{"path": project})
	if err != nil {
		t.Fatal(err)
	}
	if _, present := result["pathIdentities"]; present {
		t.Fatalf("pathIdentities present without a paths request: %+v", result)
	}
}

func TestProjectGitWriteStatusReturnsContentAwareIdentities(t *testing.T) {
	root := t.TempDir()
	project := initWritableRepo(t, root)
	if err := os.WriteFile(filepath.Join(project, "README.md"), []byte("hello-changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	handler := projectGitWriteStatus(testWritableConfig(t, root, project))
	result, err := handler(context.Background(), map[string]any{
		"path": project, "paths": []any{"README.md", "does-not-exist.txt"},
	})
	if err != nil {
		t.Fatal(err)
	}
	identities, ok := result["pathIdentities"].([]any)
	if !ok || len(identities) != 2 {
		t.Fatalf("pathIdentities = %#v, want 2 entries", result["pathIdentities"])
	}
	readme, ok := identities[0].(map[string]any)
	if !ok || readme["kind"] != "file" || readme["contentHash"] == nil {
		t.Fatalf("README.md identity = %+v, want kind=file with a contentHash", readme)
	}
	missing, ok := identities[1].(map[string]any)
	if !ok || missing["kind"] != "absent" {
		t.Fatalf("missing-file identity = %+v, want kind=absent", missing)
	}
}

// TestProjectGitWriteStatusIdentityCatchesSameSizeSameMtimeContentChange is
// the operation-layer regression test for the exact scenario the fingerprint
// re-review asked to be proven: a file edited so its size and mtime are both
// unchanged from a prior observation must still produce a different
// contentHash.
func TestProjectGitWriteStatusIdentityCatchesSameSizeSameMtimeContentChange(t *testing.T) {
	root := t.TempDir()
	project := initWritableRepo(t, root)
	handler := projectGitWriteStatus(testWritableConfig(t, root, project))
	readmePath := filepath.Join(project, "README.md")

	fixedMtime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	if err := os.WriteFile(readmePath, []byte("aaaaa\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(readmePath, fixedMtime, fixedMtime); err != nil {
		t.Fatal(err)
	}
	before, err := handler(context.Background(), map[string]any{"path": project, "paths": []any{"README.md"}})
	if err != nil {
		t.Fatal(err)
	}

	if err := os.WriteFile(readmePath, []byte("bbbbb\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(readmePath, fixedMtime, fixedMtime); err != nil {
		t.Fatal(err)
	}
	after, err := handler(context.Background(), map[string]any{"path": project, "paths": []any{"README.md"}})
	if err != nil {
		t.Fatal(err)
	}

	beforeHash := before["pathIdentities"].([]any)[0].(map[string]any)["contentHash"]
	afterHash := after["pathIdentities"].([]any)[0].(map[string]any)["contentHash"]
	if beforeHash == afterHash {
		t.Fatalf("contentHash unchanged despite different content at identical size/mtime: %v", beforeHash)
	}
}
