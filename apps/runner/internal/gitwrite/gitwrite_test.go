package gitwrite

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

// initRepo builds a repository with an explicit *local* identity (never
// global), matching what Commit requires and what a real registered project
// may or may not have configured.
func initRepo(t *testing.T, withIdentity bool) string {
	t.Helper()
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "main")
	if withIdentity {
		runGit(t, dir, "config", "user.email", "owner@example.com")
		runGit(t, dir, "config", "user.name", "Project Owner")
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if withIdentity {
		runGit(t, dir, "add", "README.md")
		runGit(t, dir, "commit", "-q", "-m", "initial commit")
	}
	return dir
}

func headSHA(t *testing.T, dir string) string {
	t.Helper()
	return strings.TrimSpace(runGit(t, dir, "rev-parse", "HEAD"))
}

func indexSHA256(t *testing.T, dir string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(dir, ".git", "index"))
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestCommitCreatesExactlySelectedFiles(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)

	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one-changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello-changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "a.txt")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one-changed-again\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	indexBefore := indexSHA256(t, dir)

	result, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: touch README only",
		Paths: []string{"README.md"},
	})
	if err != nil {
		t.Fatalf("Commit() error = %v", err)
	}
	if result.Branch != "main" || result.PreviousHeadSHA != before {
		t.Fatalf("unexpected result: %+v", result)
	}
	if headSHA(t, dir) != result.CommitSHA {
		t.Fatalf("HEAD did not move to the reported commit")
	}

	changed := strings.Fields(runGit(t, dir, "diff", "--name-only", before, result.CommitSHA))
	if !reflect.DeepEqual(changed, []string{"README.md"}) {
		t.Fatalf("commit changed %v, want only README.md", changed)
	}

	if indexSHA256(t, dir) == indexBefore {
		t.Fatal("expected the real index to change (README.md reconciled) but it did not")
	}
	// a.txt was `git add`ed as a new file and then modified again, so its
	// correct porcelain status is staged-added + unstaged-modified ("AM").
	// Anything else means Commit's throwaway index touched the user's own
	// staging of a file it was never asked to commit.
	status := runGit(t, dir, "status", "--porcelain=v1")
	if !strings.Contains(status, "AM a.txt") {
		t.Fatalf("user's own staged a.txt was disturbed; status:\n%s", status)
	}
}

func TestCommitDoesNotMutateWorkingTreeFiles(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	beforeContent, err := os.ReadFile(filepath.Join(dir, "README.md"))
	if err != nil {
		t.Fatal(err)
	}

	if _, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: change readme",
		Paths: []string{"README.md"},
	}); err != nil {
		t.Fatal(err)
	}

	afterContent, err := os.ReadFile(filepath.Join(dir, "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(beforeContent, afterContent) {
		t.Fatal("Commit mutated the working tree file it committed")
	}
}

func TestCommitSupportsUnbornBranch(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, false)
	runGit(t, dir, "config", "user.email", "owner@example.com")
	runGit(t, dir, "config", "user.name", "Project Owner")

	result, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: "", Message: "feat: initial commit",
		Paths: []string{"README.md"},
	})
	if err != nil {
		t.Fatalf("Commit() on unborn branch error = %v", err)
	}
	if result.PreviousHeadSHA != "" {
		t.Fatalf("PreviousHeadSHA = %q, want empty for a first commit", result.PreviousHeadSHA)
	}
	if headSHA(t, dir) != result.CommitSHA {
		t.Fatal("HEAD did not resolve to the new commit")
	}
}

func TestCommitRejectsWrongExpectedHead(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: strings.Repeat("a", 40), Message: "feat: x",
		Paths: []string{"README.md"},
	})
	if !errors.Is(err, ErrHeadMoved) {
		t.Fatalf("error = %v, want ErrHeadMoved", err)
	}
}

func TestCommitRejectsWhenBranchMovedBetweenObservationAndExecution(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Simulate a concurrent commit landing on the branch after the caller
	// observed `before` but before this Commit call executes.
	runGit(t, dir, "commit", "--allow-empty", "-q", "-m", "concurrent commit")
	movedHead := headSHA(t, dir)

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x",
		Paths: []string{"README.md"},
	})
	if !errors.Is(err, ErrHeadMoved) {
		t.Fatalf("error = %v, want ErrHeadMoved", err)
	}
	if headSHA(t, dir) != movedHead {
		t.Fatal("a rejected commit must not have moved HEAD")
	}
}

func TestCommitRejectsDetachedHead(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	sha := headSHA(t, dir)
	runGit(t, dir, "checkout", "-q", sha)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: sha, Message: "feat: x", Paths: []string{"README.md"},
	})
	if !errors.Is(err, ErrDetachedHead) {
		t.Fatalf("error = %v, want ErrDetachedHead", err)
	}
}

func TestCommitRejectsBranchMismatch(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "develop", ExpectedHead: before, Message: "feat: x", Paths: []string{"README.md"},
	})
	if !errors.Is(err, ErrBranchMismatch) {
		t.Fatalf("error = %v, want ErrBranchMismatch", err)
	}
}

func TestCommitRejectsMergeInProgress(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)
	if err := os.WriteFile(filepath.Join(dir, ".git", "MERGE_HEAD"), []byte(before+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x", Paths: []string{"README.md"},
	})
	if !errors.Is(err, ErrMergeInProgress) {
		t.Fatalf("error = %v, want ErrMergeInProgress", err)
	}
}

func TestCommitRejectsUnmergedPaths(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "main")
	runGit(t, dir, "config", "user.email", "owner@example.com")
	runGit(t, dir, "config", "user.name", "Project Owner")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("base\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "f.txt")
	runGit(t, dir, "commit", "-q", "-m", "base")
	runGit(t, dir, "checkout", "-q", "-b", "other")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "commit", "-q", "-am", "other change")
	runGit(t, dir, "checkout", "-q", "main")
	if err := os.WriteFile(filepath.Join(dir, "f.txt"), []byte("main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "commit", "-q", "-am", "main change")
	before := headSHA(t, dir)
	cmd := exec.Command("git", "merge", "-q", "--no-edit", "other")
	cmd.Dir = dir
	_ = cmd.Run() // expected to fail with a conflict; that's the point

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x", Paths: []string{"f.txt"},
	})
	if !errors.Is(err, ErrUnmergedPaths) && !errors.Is(err, ErrMergeInProgress) {
		t.Fatalf("error = %v, want ErrUnmergedPaths or ErrMergeInProgress", err)
	}
}

func TestCommitRejectsMissingCommitIdentity(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, false)
	// No local user.name/user.email configured — Commit must not fabricate one.
	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: "", Message: "feat: x", Paths: []string{"README.md"},
	})
	if !errors.Is(err, ErrCommitIdentityMissing) {
		t.Fatalf("error = %v, want ErrCommitIdentityMissing", err)
	}
}

func TestCommitDoesNotInheritGlobalIdentity(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, false)
	globalConfig := filepath.Join(t.TempDir(), "gitconfig")
	if err := os.WriteFile(globalConfig, []byte("[user]\n\tname = Global User\n\temail = global@example.com\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Dir(globalConfig))
	t.Setenv("GIT_CONFIG_GLOBAL", globalConfig)

	// Even though the calling process's own environment now points at a
	// global identity, gitwrite's from-scratch child environment must not
	// inherit it — GIT_CONFIG_GLOBAL=/dev/null is hard-coded in run().
	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: "", Message: "feat: x", Paths: []string{"README.md"},
	})
	if !errors.Is(err, ErrCommitIdentityMissing) {
		t.Fatalf("error = %v, want ErrCommitIdentityMissing (global identity must not leak in)", err)
	}
}

func TestCommitRejectsProtectedPath(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("SECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x", Paths: []string{".env"},
	})
	if !errors.Is(err, ErrProtectedPathSelected) {
		t.Fatalf("error = %v, want ErrProtectedPathSelected", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".git", "index.lock")); statErr == nil {
		t.Fatal("a rejected commit left a stale index lock")
	}
}

func TestCommitRejectsPathTraversal(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x",
		Paths: []string{"../outside.txt"},
	})
	if !errors.Is(err, ErrInvalidPath) {
		t.Fatalf("error = %v, want ErrInvalidPath", err)
	}
}

func TestCommitRejectsSubmodulePath(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)
	nested := t.TempDir()
	runGit(t, nested, "init", "-q", "-b", "main", ".")
	nestedCmd := exec.Command("git", "-C", nested, "config", "user.email", "x@example.com")
	if out, err := nestedCmd.CombinedOutput(); err != nil {
		t.Fatalf("git config: %v\n%s", err, out)
	}
	runGit(t, nested, "config", "user.name", "X")
	if err := os.WriteFile(filepath.Join(nested, "f.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, nested, "add", "f.txt")
	runGit(t, nested, "commit", "-q", "-m", "nested init")
	// `git submodule add` needs an explicit local-protocol allowance and the
	// nested repository to actually have a commit checked out.
	runGit(t, dir, "-c", "protocol.file.allow=always", "submodule", "add", "--quiet", nested, "vendor-repo")

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x", Paths: []string{"vendor-repo"},
	})
	if !errors.Is(err, ErrSubmodulePathSelected) {
		t.Fatalf("error = %v, want ErrSubmodulePathSelected", err)
	}
}

func TestCommitRejectsEmptySelection(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)

	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x", Paths: nil,
	})
	if !errors.Is(err, ErrEmptySelection) {
		t.Fatalf("error = %v, want ErrEmptySelection", err)
	}
}

func TestCommitRejectsNoopSelection(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)

	// README.md is unchanged relative to HEAD; selecting it produces an
	// identical tree, which must be refused rather than create an empty
	// commit silently.
	_, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x", Paths: []string{"README.md"},
	})
	if !errors.Is(err, ErrEmptySelection) {
		t.Fatalf("error = %v, want ErrEmptySelection", err)
	}
	if headSHA(t, dir) != before {
		t.Fatal("HEAD moved for a no-op selection")
	}
}

func TestCommitDoesNotRunHooks(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)
	marker := filepath.Join(t.TempDir(), "hook-ran")
	hooksDir := filepath.Join(dir, ".git", "hooks")
	for _, hookName := range []string{"pre-commit", "commit-msg", "post-commit"} {
		hookPath := filepath.Join(hooksDir, hookName)
		script := "#!/bin/sh\ntouch '" + marker + "'\nexit 0\n"
		if err := os.WriteFile(hookPath, []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x", Paths: []string{"README.md"},
	}); err != nil {
		t.Fatal(err)
	}
	if _, statErr := os.Stat(marker); !os.IsNotExist(statErr) {
		t.Fatal("a repository-local hook was executed by Commit")
	}
}

func TestCommitAuthorshipComesFromLocalConfigNotFabricated(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: before, Message: "feat: x", Paths: []string{"README.md"},
	})
	if err != nil {
		t.Fatal(err)
	}
	authorLine := runGit(t, dir, "show", "-s", "--format=%an <%ae>", result.CommitSHA)
	if strings.TrimSpace(authorLine) != "Project Owner <owner@example.com>" {
		t.Fatalf("author = %q, want the repository's own local identity", strings.TrimSpace(authorLine))
	}
}

func TestCommitLeavesRealIndexUnchangedUntilTheFinalStep(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t, true)
	before := headSHA(t, dir)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A wrong expected head must fail before any index or ref mutation.
	indexBefore := indexSHA256(t, dir)
	if _, err := Commit(context.Background(), dir, CommitOptions{
		Branch: "main", ExpectedHead: strings.Repeat("f", 40), Message: "feat: x", Paths: []string{"README.md"},
	}); !errors.Is(err, ErrHeadMoved) {
		t.Fatalf("error = %v, want ErrHeadMoved", err)
	}
	if indexSHA256(t, dir) != indexBefore {
		t.Fatal("real index changed even though Commit was rejected")
	}
	if headSHA(t, dir) != before {
		t.Fatal("HEAD moved even though Commit was rejected")
	}
}

func TestSafeRepositoryRelativePathRejectsEscapes(t *testing.T) {
	cases := map[string]bool{
		"a.txt":       true,
		"dir/a.txt":   true,
		"":            false,
		"/etc/passwd": false,
		"../a.txt":    false,
		"a/../../b":   false,
		"a\x00.txt":   false,
		"a/./b":       false,
	}
	for input, want := range cases {
		if got := safeRepositoryRelativePath(input); got != want {
			t.Errorf("safeRepositoryRelativePath(%q) = %v, want %v", input, got, want)
		}
	}
}

func TestIsProtectedPathMatchesKnownSensitiveNames(t *testing.T) {
	protected := []string{
		".env", ".env.local", "backend/.env.production", "id_rsa", "keys/id_ed25519",
		"private.pem", "server.key", "secrets/anything.txt", ".ssh/config", ".aws/credentials",
		"a/service-account-prod.json", ".npmrc", ".netrc", ".pgpass",
	}
	for _, path := range protected {
		if !IsProtectedPath(path) {
			t.Errorf("IsProtectedPath(%q) = false, want true", path)
		}
	}
	safe := []string{"README.md", "src/index.ts", "environment.ts", "keys.md", "envfile.txt"}
	for _, path := range safe {
		if IsProtectedPath(path) {
			t.Errorf("IsProtectedPath(%q) = true, want false", path)
		}
	}
}
