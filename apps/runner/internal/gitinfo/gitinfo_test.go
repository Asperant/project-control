package gitinfo

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
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

func TestInspectDevelopmentUnbornRepository(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := t.TempDir()
	runGit(t, dir, "init", "-q", "-b", "fresh")
	got, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Repository.Available || !got.Repository.IsRepository || got.Repository.ErrorCode != "" {
		t.Fatalf("repository = %+v", got.Repository)
	}
	if !got.Head.Unborn || got.Head.Branch != "fresh" || got.Head.SHA != "" || got.Head.Detached {
		t.Fatalf("head = %+v, want unborn fresh branch", got.Head)
	}
}

func TestInspectDevelopmentPlainDirectoryIsSafeMachineResult(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	got, err := InspectDevelopment(context.Background(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !got.Repository.Available || got.Repository.IsRepository || got.Repository.ErrorCode != "not_repository" {
		t.Fatalf("repository = %+v", got.Repository)
	}
	if got.Remote != nil || len(got.Files) != 0 || len(got.RecentCommits) != 0 {
		t.Fatalf("unexpected metadata: %+v", got)
	}
}

func TestInspectDevelopmentDetachedHead(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	sha := strings.TrimSpace(runGit(t, dir, "rev-parse", "HEAD"))
	runGit(t, dir, "checkout", "-q", "--detach", sha)
	got, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !got.Head.Detached || got.Head.Branch != "" || got.Head.Unborn || got.Head.SHA != sha {
		t.Fatalf("head = %+v, want detached %s", got.Head, sha)
	}
}

func TestInspectDevelopmentReportsConflict(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	runGit(t, dir, "checkout", "-q", "-b", "other")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("other\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "commit", "-qam", "other change")
	runGit(t, dir, "checkout", "-q", "main")
	if err := os.WriteFile(filepath.Join(dir, "README.md"), []byte("main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "commit", "-qam", "main change")
	cmd := exec.Command("git", "merge", "other")
	cmd.Dir = dir
	if err := cmd.Run(); err == nil {
		t.Fatal("expected merge conflict in test setup")
	}
	got, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkingTree.ConflictedCount != 1 || len(got.Files) != 1 || got.Files[0].State != "conflicted" {
		t.Fatalf("conflict metadata missing: %+v / %+v", got.WorkingTree, got.Files)
	}
}

func TestInspectDevelopmentReportsDelete(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "delete-me"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "delete-me")
	runGit(t, dir, "commit", "-q", "-m", "track delete-me")
	if err := os.Remove(filepath.Join(dir, "delete-me")); err != nil {
		t.Fatal(err)
	}
	got, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	foundDelete := false
	for _, file := range got.Files {
		if file.Path == "delete-me" && file.State == "deleted" && file.Unstaged {
			foundDelete = true
		}
	}
	if !foundDelete {
		t.Fatalf("delete metadata missing: %+v", got.Files)
	}
}

func TestInspectDevelopmentWorkingTreeMetadata(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	runGit(t, dir, "mv", "README.md", "renamed.txt")
	if err := os.WriteFile(filepath.Join(dir, "renamed.txt"), []byte("unstaged\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "loose.txt"), []byte("untracked\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.WorkingTree.Clean || got.WorkingTree.StagedCount != 1 || got.WorkingTree.UnstagedCount != 1 || got.WorkingTree.UntrackedCount != 1 || got.WorkingTree.TotalChangedCount != 2 {
		t.Fatalf("working tree = %+v", got.WorkingTree)
	}
	var renamed *ChangedFile
	for i := range got.Files {
		if got.Files[i].State == "renamed" {
			renamed = &got.Files[i]
		}
	}
	if renamed == nil || renamed.OldPath != "README.md" || renamed.Path != "renamed.txt" || !renamed.Staged || !renamed.Unstaged {
		t.Fatalf("rename metadata missing: %+v", got.Files)
	}
}

func TestInspectDevelopmentBoundsFilesAndCommits(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	for i := 0; i < maxRecentCommits+2; i++ {
		name := filepath.Join(dir, fmt.Sprintf("commit-%02d", i))
		if err := os.WriteFile(name, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
		runGit(t, dir, "add", filepath.Base(name))
		runGit(t, dir, "commit", "-q", "-m", fmt.Sprintf("commit %02d", i))
	}
	const changedFileCount = 1100
	for i := 0; i < changedFileCount; i++ {
		name := fmt.Sprintf("loose-%04d-%s", i, strings.Repeat("x", 220))
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.RecentCommits) != maxRecentCommits || got.RecentCommits[0].Subject != "commit 21" {
		t.Fatalf("recent commits = %d/%+v", len(got.RecentCommits), got.RecentCommits)
	}
	if len(got.Files) != maxChangedFiles || got.WorkingTree.TotalChangedCount != changedFileCount || !got.WorkingTree.FilesTruncated {
		t.Fatalf("file bounds = %d/%+v", len(got.Files), got.WorkingTree)
	}
}

func TestInspectDevelopmentUsesFixedShortSHARegardlessOfCoreAbbrev(t *testing.T) {
	dir := initRepo(t)
	runGit(t, dir, "config", "core.abbrev", "4")
	got, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.RecentCommits) != 1 || len(got.RecentCommits[0].ShortSHA) != 7 || got.RecentCommits[0].ShortSHA != got.RecentCommits[0].SHA[:7] {
		t.Fatalf("recent commits = %+v, want fixed seven-character short SHA", got.RecentCommits)
	}
}

func TestRecentCommitTextIsBoundedForThePublicContract(t *testing.T) {
	dir := initRepo(t)
	if err := os.WriteFile(filepath.Join(dir, "long-subject"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "long-subject")
	runGit(t, dir, "commit", "-q", "-m", strings.Repeat("S", 1200))
	got, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.RecentCommits) == 0 || len(got.RecentCommits[0].Subject) != 1000 {
		t.Fatalf("bounded commit metadata = %+v", got.RecentCommits)
	}
	if author := safeBoundedSingleLine(strings.Repeat("A", 600), 500); len(author) != 500 {
		t.Fatalf("bounded author length = %d", len(author))
	}
}

func TestCommitHashPatternAcceptsSHA1AndSHA256(t *testing.T) {
	for _, hash := range []string{strings.Repeat("a", 40), strings.Repeat("b", 64)} {
		if !commitHashPattern.MatchString(hash) {
			t.Fatalf("full Git object ID rejected: %s", hash)
		}
	}
}

func TestInspectDevelopmentOriginAndLocalTracking(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	runGit(t, dir, "remote", "add", "origin", "https://alice:secret@github.com/acme/demo.git?token=bad#fragment")
	base := strings.TrimSpace(runGit(t, dir, "rev-parse", "HEAD"))
	runGit(t, dir, "update-ref", "refs/remotes/origin/main", base)
	runGit(t, dir, "config", "branch.main.remote", "origin")
	runGit(t, dir, "config", "branch.main.merge", "refs/heads/main")
	if err := os.WriteFile(filepath.Join(dir, "ahead.txt"), []byte("ahead"), 0o644); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "add", "ahead.txt")
	runGit(t, dir, "commit", "-q", "-m", "ahead")

	got, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if got.Remote == nil {
		t.Fatal("expected origin")
	}
	if got.Remote.RawURL != "https://github.com/acme/demo.git" || got.Remote.Host != "github.com" || got.Remote.Owner != "acme" || got.Remote.Repository != "demo" {
		t.Fatalf("remote leaked or parsed incorrectly: %+v", got.Remote)
	}
	if got.Remote.TrackingBranch != "origin/main" || got.Remote.ComparisonBasis != "local_tracking_ref" || got.Remote.Ahead == nil || *got.Remote.Ahead != 1 || got.Remote.Behind == nil || *got.Remote.Behind != 0 {
		t.Fatalf("tracking = %+v", got.Remote)
	}
	if !got.GitHub.Detected || got.GitHub.Configured || got.GitHub.Status != "not_configured" {
		t.Fatalf("github = %+v", got.GitHub)
	}
}

func TestParseRemoteRejectsUnsafeAndUnsupportedRaw(t *testing.T) {
	cases := []string{
		"file:///tmp/repo", "https://github.com/acme/demo.git\nsecret", "not a remote",
		"https://github.com/too/many/parts.git", "git@github.com:acme/demo.git?access=TOPSECRET",
		"git@github.com:acme/demo.git#private",
	}
	for _, input := range cases {
		safe, _, _, _, ok := parseRemote(input)
		if ok || safe != "" {
			t.Errorf("parseRemote(%q) = %q, ok=%v", input, safe, ok)
		}
	}
}

func TestParseRemoteReconstructsSafeSCPForm(t *testing.T) {
	safe, host, owner, repository, ok := parseRemote("deploy@github.com:acme/demo.git")
	if !ok || safe != "git@github.com:acme/demo.git" || host != "github.com" || owner != "acme" || repository != "demo" {
		t.Fatalf("got %q %q %q %q %v", safe, host, owner, repository, ok)
	}
}

func TestParsePorcelainV2RejectsEscapingPaths(t *testing.T) {
	for _, path := range []string{"/tmp/secret", "../secret", "nested/../../secret", `nested\..\secret`} {
		result := Development{WorkingTree: WorkingTree{Clean: true}}
		if parsePorcelainV2("? "+path+"\x00", &result) {
			t.Errorf("accepted escaping path %q", path)
		}
	}
}

func TestInspectDevelopmentUnsafePathProducesFailedSafeState(t *testing.T) {
	result := Development{Repository: Repository{Available: true, IsRepository: true}, Head: Head{Branch: "main"}, Files: []ChangedFile{{Path: "safe"}}}
	if parsePorcelainV2("? ../secret\x00", &result) {
		t.Fatal("unsafe status unexpectedly parsed")
	}
	got := failedDevelopment()
	if got.Repository.ErrorCode != "inspection_failed" || !got.Repository.Available || !got.Repository.IsRepository || len(got.Files) != 0 || got.Head.Branch != "" {
		t.Fatalf("failed state = %+v", got)
	}
}

func TestGitTextMetadataIsNormalisedToOneLine(t *testing.T) {
	if got := safeSingleLine("main\nforged\x00\tvalue\x7f"); got != "main forged  value " {
		t.Fatalf("safeSingleLine = %q", got)
	}
	result := Development{WorkingTree: WorkingTree{Clean: true}}
	if !parsePorcelainV2("# branch.head feature\nforged\x00", &result) {
		t.Fatal("branch header rejected")
	}
	if result.Head.Branch != "feature forged" {
		t.Fatalf("branch = %q", result.Head.Branch)
	}
}

func TestParseRemoteRejectsControlAndTraversalSegments(t *testing.T) {
	for _, raw := range []string{
		"https://github.com/../demo.git",
		"https://github.com/acme/..",
		"https://github.com/acme%0Aevil/demo.git",
		"git@github.com:../demo.git",
	} {
		safe, _, _, _, ok := parseRemote(raw)
		if ok || safe != "" {
			t.Errorf("parseRemote(%q) = %q, ok=%v", raw, safe, ok)
		}
	}
}

func TestInspectDevelopmentDisablesConfiguredFSMonitorAndDoesNotMutateRepository(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	marker := filepath.Join(t.TempDir(), "fsmonitor-ran")
	hook := filepath.Join(t.TempDir(), "fsmonitor.sh")
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ntouch '"+marker+"'\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	runGit(t, dir, "config", "core.fsmonitor", hook)

	paths := []string{filepath.Join(dir, ".git", "HEAD"), filepath.Join(dir, ".git", "index"), filepath.Join(dir, ".git", "config"), filepath.Join(dir, "README.md")}
	before := map[string][]byte{}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		before[path] = data
	}
	refsBefore := runGit(t, dir, "show-ref")
	if _, err := InspectDevelopment(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("configured fsmonitor was executed: %v", err)
	}
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(before[path], data) {
			t.Fatalf("inspection mutated %s", path)
		}
	}
	if refsAfter := runGit(t, dir, "show-ref"); refsAfter != refsBefore {
		t.Fatal("inspection mutated refs")
	}
}

func TestGitEnvironmentDisablesLazyFetch(t *testing.T) {
	originalGitPath := gitPath
	t.Cleanup(func() { gitPath = originalGitPath })
	probe := filepath.Join(t.TempDir(), "git-env-probe")
	if err := os.WriteFile(probe, []byte("#!/bin/sh\nprintf '%s' \"$GIT_NO_LAZY_FETCH\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	gitPath = probe
	out, err := run(context.Background(), t.TempDir(), "status")
	if err != nil {
		t.Fatal(err)
	}
	if out != "1" {
		t.Fatalf("GIT_NO_LAZY_FETCH = %q, want 1", out)
	}
}

// TestInspectDevelopmentSucceedsUnderDifferentOwnership guards against a
// regression of a real production condition: the runner's uid never matches
// the filesystem owner of a registered project by design (see the
// internal/gitinfo package doc), and git >= 2.35.2 refuses to operate on a
// repository it does not own ("detected dubious ownership") unless
// safe.directory names it explicitly.
//
// GIT_TEST_ASSUME_DIFFERENT_OWNER=1 is git's own test hook for exercising
// that exact path without actually chown-ing the fixture, but gitCommand
// builds the child's environment from a fixed literal list rather than
// os.Environ(), so t.Setenv on the test process would never reach the git
// subprocess. A thin wrapper script that exports the variable itself, then
// execs the real git, is what TestGitEnvironmentDisablesLazyFetch below uses
// for the same reason, and is reused here.
func TestInspectDevelopmentSucceedsUnderDifferentOwnership(t *testing.T) {
	if !Available() {
		t.Skip("git binary not available")
	}
	dir := initRepo(t)
	realGit := gitPath

	wrapper := filepath.Join(t.TempDir(), "git-dubious-owner-wrapper.sh")
	script := "#!/bin/sh\nexport GIT_TEST_ASSUME_DIFFERENT_OWNER=1\nexec '" + realGit + "' \"$@\"\n"
	if err := os.WriteFile(wrapper, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}

	originalGitPath := gitPath
	t.Cleanup(func() { gitPath = originalGitPath })
	gitPath = wrapper

	development, err := InspectDevelopment(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !development.Repository.IsRepository {
		t.Fatalf("repository not detected under simulated different ownership: %+v", development.Repository)
	}
	if development.Repository.ErrorCode != "" {
		t.Fatalf("unexpected error code under simulated different ownership: %q", development.Repository.ErrorCode)
	}
	if development.Head.Branch != "main" {
		t.Fatalf("branch = %q, want %q", development.Head.Branch, "main")
	}

	summary, err := Summarise(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if !summary.Present {
		t.Fatal("Summarise reported Present=false under simulated different ownership")
	}
}

func TestStatusRecordScannerRejectsOversizedSingleRecord(t *testing.T) {
	scanner := bufio.NewScanner(strings.NewReader(strings.Repeat("x", maxStatusRecordBytes+1) + "\x00"))
	scanner.Buffer(make([]byte, 4096), maxStatusRecordBytes)
	scanner.Split(splitNUL)
	if scanner.Scan() || scanner.Err() == nil {
		t.Fatalf("oversized status record was not rejected: token=%q err=%v", scanner.Text(), scanner.Err())
	}
}
