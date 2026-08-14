package gitinfo

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func runGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.com",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func initRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "main")
	runGit(t, dir, "config", "user.email", "test@example.com")
	runGit(t, dir, "config", "user.name", "Test")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "README.md")
	runGit(t, dir, "commit", "-q", "-m", "initial commit")
	return dir
}

func TestSummariseNotAGitDirectory(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	summary, err := Summarise(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if summary.Present {
		t.Fatal("expected Present=false for a plain directory")
	}
}

func TestSummariseCleanRepo(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)

	summary, err := Summarise(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !summary.Present {
		t.Fatal("expected Present=true")
	}
	if summary.ActiveBranch != "main" {
		t.Fatalf("branch = %q, want main", summary.ActiveBranch)
	}
	if summary.IsDirty {
		t.Fatal("expected a clean working tree")
	}
	if summary.ModifiedCount != 0 || summary.UntrackedCount != 0 {
		t.Fatalf("counts = %d/%d, want 0/0", summary.ModifiedCount, summary.UntrackedCount)
	}
	if summary.LastCommitSubject != "initial commit" {
		t.Fatalf("subject = %q", summary.LastCommitSubject)
	}
	if len(summary.LastCommitHash) != 40 {
		t.Fatalf("hash = %q, want 40 hex chars", summary.LastCommitHash)
	}
	resolvedDir, _ := filepath.EvalSymlinks(dir)
	if summary.TopLevelPath != resolvedDir {
		t.Fatalf("topLevel = %q, want %q", summary.TopLevelPath, resolvedDir)
	}
}

func TestSummariseDirtyRepoCountsModifiedAndUntracked(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("changed\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "new.txt"), []byte("new\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	summary, err := Summarise(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !summary.IsDirty {
		t.Fatal("expected a dirty working tree")
	}
	if summary.ModifiedCount != 1 {
		t.Fatalf("modified = %d, want 1", summary.ModifiedCount)
	}
	if summary.UntrackedCount != 1 {
		t.Fatalf("untracked = %d, want 1", summary.UntrackedCount)
	}
}

func TestSummariseRedactsRemoteCredentials(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	runGit(t, dir, "remote", "add", "origin", "https://alice:s3cr3t@example.com/org/repo.git")

	summary, err := Summarise(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Remotes) != 1 {
		t.Fatalf("remotes = %v, want 1 entry", summary.Remotes)
	}
	if strings.Contains(summary.Remotes[0].URL, "s3cr3t") || strings.Contains(summary.Remotes[0].URL, "alice") {
		t.Fatalf("credential leaked into remote URL: %q", summary.Remotes[0].URL)
	}
	if summary.Remotes[0].URL != "https://example.com/org/repo.git" {
		t.Fatalf("sanitised URL = %q", summary.Remotes[0].URL)
	}
}

func TestSummariseDetachedHead(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	hash := strings.TrimSpace(runGit(t, dir, "rev-parse", "HEAD"))
	runGit(t, dir, "checkout", "-q", hash)

	summary, err := Summarise(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !summary.Detached {
		t.Fatal("expected a detached HEAD")
	}
	if summary.ActiveBranch != "" {
		t.Fatalf("branch = %q, want empty when detached", summary.ActiveBranch)
	}
}

func TestSummariseDefaultBranchKnownFromOriginHEAD(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	runGit(t, dir, "update-ref", "refs/remotes/origin/main", "HEAD")
	runGit(t, dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

	summary, err := Summarise(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if summary.DefaultBranchConfidence != "known" {
		t.Fatalf("confidence = %q, want known", summary.DefaultBranchConfidence)
	}
	if summary.DefaultBranch != "main" {
		t.Fatalf("default branch = %q, want main", summary.DefaultBranch)
	}
}

func TestSummariseDefaultBranchInferredWithoutOriginHEAD(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)

	summary, err := Summarise(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if summary.DefaultBranchConfidence != "inferred" {
		t.Fatalf("confidence = %q, want inferred (no origin/HEAD present)", summary.DefaultBranchConfidence)
	}
	if summary.DefaultBranch != "main" {
		t.Fatalf("default branch = %q, want main", summary.DefaultBranch)
	}
}

// TestSummariseNeverWritesTheIndex is the load-bearing test for the runner's
// "never updates the git index" guarantee. It stages a condition a normal
// `git status` would opportunistically fix by rewriting .git/index (a stale
// cached mtime with unchanged content) and asserts the file is byte-identical
// afterwards.
func TestSummariseNeverWritesTheIndex(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)

	future := time.Now().Add(2 * time.Hour)
	if err := os.Chtimes(filepath.Join(dir, "README.md"), future, future); err != nil {
		t.Fatal(err)
	}

	indexPath := filepath.Join(dir, ".git", "index")
	before, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := Summarise(context.Background(), dir); err != nil {
		t.Fatal(err)
	}

	after, err := os.ReadFile(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("Summarise modified .git/index; the runner must never write to a project's git state")
	}
}

func TestSummariseRejectsRelativeDirectory(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	if _, err := Summarise(context.Background(), "relative/path"); err == nil {
		t.Fatal("expected an error for a non-absolute directory")
	}
}

func TestSanitiseRemoteURLPassesThroughSSHForm(t *testing.T) {
	got := sanitiseRemoteURL("git@github.com:org/repo.git")
	if got != "git@github.com:org/repo.git" {
		t.Fatalf("got %q, want unchanged SSH form", got)
	}
}
