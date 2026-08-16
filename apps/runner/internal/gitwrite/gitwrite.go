// Package gitwrite performs the runner's one mutating filesystem operation:
// committing a caller-selected set of paths to the current branch of a
// repository the operator has explicitly opted into write access for.
//
// # Why this is a separate package from gitinfo
//
// internal/gitinfo is read-only, and its package doc explains at length why
// every invocation in it is safe. Keeping every mutating call in a distinct
// package means "gitinfo never writes" stays true by construction and stays
// auditable by inspecting one file, rather than becoming a claim that has to
// be verified call-by-call across a package that also does I/O.
//
// # What actually makes a commit here safe
//
// A commit built with `git add <paths>` followed by `git commit` operates on
// the repository's real index — the same index the project owner's own editor
// or `git status` is looking at. If anything else were staged there, it would
// be swept into the commit unintentionally. This package never does that.
// Instead it stages into a throwaway index built fresh from HEAD
// (GIT_INDEX_FILE pointed at a temp file inside the repository's own .git
// directory, removed when the call returns), builds a tree and a commit
// object from that throwaway index with plumbing commands, and only then
// touches anything the caller can observe:
//
//  1. `read-tree HEAD` into the temp index (skipped for an unborn branch).
//  2. `update-index --add --remove` for exactly the caller-selected paths,
//     against the temp index only.
//  3. `write-tree` → a tree object nothing yet references.
//  4. `ls-tree` on that tree checks none of the selected paths resolved to a
//     submodule gitlink (mode 160000); commits that add or change a
//     submodule reference are refused rather than partially handled.
//  5. `commit-tree` → a commit object nothing yet references, using identity
//     read from the repository's own *local* git config only (never
//     fabricated, never inherited from a global/system config, both of which
//     are disabled below anyway).
//  6. `update-ref refs/heads/<branch> <new> <expectedOld>` — the one call
//     that changes what the caller (or anyone else reading the repository)
//     can see. Because the third argument pins the ref's previous value, this
//     is a compare-and-swap at the layer git itself serialises: if the branch
//     moved since the caller last observed it, this fails atomically and
//     nothing else in this package has touched anything durable yet.
//
// Only after that succeeds does this package attempt to fold the same paths
// into the repository's *real* index (step 7, best-effort — see
// Result.IndexReconciled) so a subsequent `git status` in the owner's own
// terminal reads as expected rather than "these files differ from the index
// in a way nobody asked for."
//
// # Every other rule from gitinfo still applies
//
// No shell is ever involved. Every argv element besides the caller-selected
// paths, message and directory is a literal declared in this file.
// core.hooksPath=/dev/null means no hook — pre-commit, commit-msg, or
// otherwise — ever runs; a hook is caller-adjacent code execution by another
// name, which this package cannot allow regardless of what the repository's
// own .git/hooks contains. commit.gpgsign=false stops repository-local
// signing config from making a commit hang waiting for a passphrase this
// process has no way to supply. safe.directory is scoped to the exact,
// already write-validated directory for the same reason gitinfo needs it:
// the runner's uid never matches a project's filesystem owner by design.
package gitwrite

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// MaxOutputBytes bounds how much of any single git command's stdout this
// package will read. Every command here produces at most a few lines of
// plumbing output (an object id, a tree listing of the selected paths).
const MaxOutputBytes = 256 * 1024

// MaxPaths bounds how many paths a single commit may select. This mirrors the
// operation's own registry.ParamSpec limit and is enforced again here so the
// package is safe to call directly in tests without relying on that layer.
const MaxPaths = 200

// branchRefPrefix is prepended to a branch name to form a full ref name, and
// stripped from `symbolic-ref HEAD` output to recover one.
const branchRefPrefix = "refs/heads/"

var emptyTreeSHA = map[int]string{
	40: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
	64: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
}

// Sentinel errors. Callers (the runner operation handler) map these to the
// stable, machine-readable reason codes returned to the Control API; they are
// never surfaced to an end user as raw Go error text.
var (
	ErrUnsupportedGitLayout  = errors.New("gitwrite: repository is not a plain, non-worktree, non-submodule layout")
	ErrDetachedHead          = errors.New("gitwrite: HEAD is detached")
	ErrBranchMismatch        = errors.New("gitwrite: current branch does not match the requested branch")
	ErrHeadMoved             = errors.New("gitwrite: the branch has moved since it was last observed")
	ErrMergeInProgress       = errors.New("gitwrite: a merge, rebase or cherry-pick is in progress")
	ErrUnmergedPaths         = errors.New("gitwrite: the repository has unmerged paths")
	ErrCommitIdentityMissing = errors.New("gitwrite: the repository has no local user.name/user.email configured")
	ErrProtectedPathSelected = errors.New("gitwrite: a protected path was selected")
	ErrSubmodulePathSelected = errors.New("gitwrite: a selected path resolves to a submodule")
	ErrEmptySelection        = errors.New("gitwrite: no path was selected, or the selection produces no change")
	ErrInvalidPath           = errors.New("gitwrite: a selected path is not a safe repository-relative path")
	ErrEmptyMessage          = errors.New("gitwrite: commit message must not be empty")
)

// CommitOptions describes one requested commit. Every field is caller
// input and is treated as untrusted: nothing here is executed as a command,
// interpolated into a shell string, or trusted without the checks in Commit.
type CommitOptions struct {
	// Branch is the branch the caller believes is checked out. A live
	// mismatch is ErrBranchMismatch, never a silent redirect to whatever
	// branch actually is current.
	Branch string
	// ExpectedHead is the commit SHA the caller believes HEAD currently
	// points at, or "" if the caller believes the branch is unborn (no
	// commits yet). This is the value compare-and-swapped against the live
	// ref in the final update-ref call.
	ExpectedHead string
	// Message is the commit message. The first line only is ever echoed back
	// in a result the caller may audit-log; the full message is never logged
	// by this package.
	Message string
	// Paths is the caller-selected, repository-relative path list. Every
	// entry must be new/modified/deleted relative to HEAD in the working
	// tree for the resulting commit to differ from HEAD's tree.
	Paths []string
}

// Result is what a successful Commit reports.
type Result struct {
	CommitSHA       string
	ShortSHA        string
	PreviousHeadSHA string // "" when the branch was unborn before this commit
	Branch          string
	FileCount       int
	// IndexReconciled is false when the commit succeeded (the ref now points
	// at the new commit) but folding the same paths into the repository's
	// real index afterwards failed — e.g. another process held the index
	// lock at that moment. The commit is not retried or rolled back in that
	// case; only the owner's next `git status` will look momentarily
	// surprising until they touch the index themselves.
	IndexReconciled bool
}

// protectedPathPatterns is the compiled-in, non-overridable denylist. It is a
// name-shape filter, not a secret scanner: it stops the common, careless case
// (committing a checked-in .env or private key by selecting it in a list) and
// makes no claim beyond that. See the operation's package doc for the exact
// list and that caveat spelled out for an operator audience.
var protectedPathPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?:^|/)\.env(?:\..+)?$`),
	regexp.MustCompile(`(?:^|/)\.env\..+$`),
	regexp.MustCompile(`\.pem$`),
	regexp.MustCompile(`\.key$`),
	regexp.MustCompile(`\.p12$`),
	regexp.MustCompile(`\.pfx$`),
	regexp.MustCompile(`\.keystore$`),
	regexp.MustCompile(`\.kdbx$`),
	regexp.MustCompile(`(?:^|/)id_rsa(?:\.pub)?$`),
	regexp.MustCompile(`(?:^|/)id_ed25519(?:\.pub)?$`),
	regexp.MustCompile(`(?:^|/)id_ecdsa(?:\.pub)?$`),
	regexp.MustCompile(`(?:^|/)\.netrc$`),
	regexp.MustCompile(`(?:^|/)\.npmrc$`),
	regexp.MustCompile(`(?:^|/)\.pgpass$`),
	regexp.MustCompile(`(?:^|/)credentials\.json$`),
	regexp.MustCompile(`(?:^|/)service-account.*\.json$`),
	regexp.MustCompile(`(?:^|/)secrets/`),
	regexp.MustCompile(`(?:^|/)\.aws/`),
	regexp.MustCompile(`(?:^|/)\.ssh/`),
}

// IsProtectedPath reports whether a repository-relative path matches the
// compiled-in denylist. Exported so the operation layer can report excluded
// candidates back to the caller without duplicating the pattern list.
func IsProtectedPath(path string) bool {
	for _, pattern := range protectedPathPatterns {
		if pattern.MatchString(path) {
			return true
		}
	}
	return false
}

// safeRepositoryRelativePath rejects anything that is not a plain,
// repository-relative path: absolute, empty, containing a NUL byte or a ".."
// component. Mirrors gitinfo's safeRepositoryRelativePath; duplicated rather
// than imported to keep this package's dependency surface self-contained.
func safeRepositoryRelativePath(path string) bool {
	if path == "" || strings.Contains(path, "\x00") || filepath.IsAbs(path) || strings.HasPrefix(path, "/") {
		return false
	}
	for _, segment := range strings.Split(strings.ReplaceAll(path, "\\", "/"), "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

// gitPath is resolved once, matching gitinfo's pattern: a missing git binary
// degrades every caller to a clear error rather than a panic.
var gitPath = func() string {
	p, err := exec.LookPath("git")
	if err != nil {
		return ""
	}
	return p
}()

// Available reports whether a usable `git` binary was found at startup.
func Available() bool { return gitPath != "" }

// PreflightResult is a safe, read-only report of every condition Commit
// checks before it writes anything. It is the single source of truth both
// project.git.write.status (a pure read) and Commit (which enforces it)
// consult, so the two can never silently disagree about what state a
// repository is in.
type PreflightResult struct {
	// GitLayoutSupported is false for a worktree, a submodule checkout, or
	// anything else where `.git` is not literally this repository's own git
	// directory. Every other field is zero-valued when this is false.
	GitLayoutSupported bool
	Branch             string // "" when detached or layout unsupported
	Detached           bool
	HeadSHA            string // "" when unborn, detached, or layout unsupported
	Unborn             bool
	MergeInProgress    bool
	UnmergedPaths      bool
	// IdentityConfigured reflects the repository's *local* (never global or
	// system) user.name and user.email being both present and non-empty.
	IdentityConfigured bool
}

// ready reports whether every precondition Commit enforces currently holds.
func (p PreflightResult) ready() bool {
	return p.GitLayoutSupported && !p.Detached && !p.MergeInProgress &&
		!p.UnmergedPaths && p.IdentityConfigured
}

// preflight reads every condition Commit needs to decide whether it may
// proceed. It never mutates anything and never returns an error for a normal
// "this repository isn't ready" outcome — those are reported as fields on the
// result, matching gitinfo's "safe machine result for every observational
// failure" convention. An error here means git itself could not be run at
// all (e.g. the binary is missing).
func preflight(ctx context.Context, dir string) (PreflightResult, string, error) {
	if !Available() {
		return PreflightResult{}, "", errors.New("gitwrite: git binary not available")
	}
	if !filepath.IsAbs(dir) {
		return PreflightResult{}, "", errors.New("gitwrite: dir must be an absolute path")
	}

	result := PreflightResult{}

	absGitDir, err := run(ctx, dir, nil, "rev-parse", "--absolute-git-dir")
	if err != nil {
		return result, "", nil
	}
	expectedGitDir, evalErr := filepath.EvalSymlinks(filepath.Join(dir, ".git"))
	if evalErr != nil || strings.TrimSpace(absGitDir) != expectedGitDir {
		return result, "", nil
	}
	result.GitLayoutSupported = true

	if headRef, err := run(ctx, dir, nil, "symbolic-ref", "-q", "HEAD"); err != nil {
		result.Detached = true
	} else {
		branch := strings.TrimPrefix(strings.TrimSpace(headRef), branchRefPrefix)
		if branch == strings.TrimSpace(headRef) || branch == "" {
			result.Detached = true
		} else {
			result.Branch = branch
		}
	}

	if sha, err := run(ctx, dir, nil, "rev-parse", "--verify", "-q", "HEAD"); err == nil {
		result.HeadSHA = strings.TrimSpace(sha)
	} else if !result.Detached {
		result.Unborn = true
	}

	for _, marker := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "rebase-merge", "rebase-apply"} {
		if _, statErr := os.Lstat(filepath.Join(expectedGitDir, marker)); statErr == nil {
			result.MergeInProgress = true
			break
		}
	}
	result.UnmergedPaths = hasUnmergedPaths(ctx, dir)

	authorName, nameErr := run(ctx, dir, nil, "config", "--local", "--get", "user.name")
	authorEmail, emailErr := run(ctx, dir, nil, "config", "--local", "--get", "user.email")
	result.IdentityConfigured = nameErr == nil && emailErr == nil &&
		strings.TrimSpace(authorName) != "" && strings.TrimSpace(authorEmail) != ""

	return result, expectedGitDir, nil
}

// Preflight is the read-only entry point used by project.git.write.status.
// It never writes anything; see preflight for the shared implementation also
// used internally by Commit.
func Preflight(ctx context.Context, dir string) (PreflightResult, error) {
	result, _, err := preflight(ctx, dir)
	return result, err
}

// Commit performs the sequence documented in the package doc. dir must
// already be the canonical, existing, write-validated directory produced by
// projectpath.ValidateWritable — this function does not itself consult any
// allowlist.
func Commit(ctx context.Context, dir string, opts CommitOptions) (Result, error) {
	if strings.TrimSpace(opts.Message) == "" {
		return Result{}, ErrEmptyMessage
	}
	if len(opts.Paths) == 0 || len(opts.Paths) > MaxPaths {
		return Result{}, ErrEmptySelection
	}
	seen := make(map[string]bool, len(opts.Paths))
	for _, p := range opts.Paths {
		if !safeRepositoryRelativePath(p) {
			return Result{}, ErrInvalidPath
		}
		if IsProtectedPath(p) {
			return Result{}, ErrProtectedPathSelected
		}
		if seen[p] {
			return Result{}, ErrInvalidPath
		}
		seen[p] = true
	}

	state, expectedGitDir, err := preflight(ctx, dir)
	if err != nil {
		return Result{}, err
	}
	if !state.GitLayoutSupported {
		return Result{}, ErrUnsupportedGitLayout
	}
	if state.Detached {
		return Result{}, ErrDetachedHead
	}
	if state.Branch != opts.Branch {
		return Result{}, ErrBranchMismatch
	}
	if state.HeadSHA != opts.ExpectedHead {
		return Result{}, ErrHeadMoved
	}
	if state.MergeInProgress {
		return Result{}, ErrMergeInProgress
	}
	if state.UnmergedPaths {
		return Result{}, ErrUnmergedPaths
	}
	if !state.IdentityConfigured {
		return Result{}, ErrCommitIdentityMissing
	}
	previousHeadSHA := state.HeadSHA

	authorName, _ := run(ctx, dir, nil, "config", "--local", "--get", "user.name")
	authorEmail, _ := run(ctx, dir, nil, "config", "--local", "--get", "user.email")
	authorName, authorEmail = strings.TrimSpace(authorName), strings.TrimSpace(authorEmail)

	// --- Build a throwaway index inside the repository's own .git dir ------
	//
	// CreateTemp only reserves a guaranteed-unique name; the file it creates
	// is immediately removed rather than left as a zero-byte placeholder.
	// `git update-index` on a *fresh, unborn* branch treats an existing but
	// empty file at GIT_INDEX_FILE as a corrupt index ("index file smaller
	// than expected") and refuses to proceed, whereas a path that does not
	// exist yet is exactly how git expects to be told "start a new index
	// here". `read-tree HEAD` (the non-unborn path) tolerates either, so
	// removing it up front is safe for both cases.
	tempIndex, err := os.CreateTemp(expectedGitDir, "pc-commit-*.index")
	if err != nil {
		return Result{}, fmt.Errorf("gitwrite: cannot create a temporary index: %w", err)
	}
	tempIndexPath := tempIndex.Name()
	_ = tempIndex.Close()
	_ = os.Remove(tempIndexPath)
	defer os.Remove(tempIndexPath)

	tempEnv := []string{"GIT_INDEX_FILE=" + tempIndexPath}
	if previousHeadSHA != "" {
		if _, err := run(ctx, dir, tempEnv, "read-tree", "HEAD"); err != nil {
			return Result{}, fmt.Errorf("gitwrite: read-tree failed: %w", err)
		}
	}
	updateArgs := append([]string{"update-index", "--add", "--remove", "--"}, opts.Paths...)
	if _, err := run(ctx, dir, tempEnv, updateArgs...); err != nil {
		return Result{}, fmt.Errorf("gitwrite: staging the selected paths failed: %w", err)
	}
	treeSHA, err := run(ctx, dir, tempEnv, "write-tree")
	if err != nil {
		return Result{}, fmt.Errorf("gitwrite: write-tree failed: %w", err)
	}
	treeSHA = strings.TrimSpace(treeSHA)

	if noop, err := isNoopTree(ctx, dir, treeSHA, previousHeadSHA); err != nil {
		return Result{}, fmt.Errorf("gitwrite: comparing the new tree failed: %w", err)
	} else if noop {
		return Result{}, ErrEmptySelection
	}

	if submodule, err := treeContainsSubmodule(ctx, dir, treeSHA, opts.Paths); err != nil {
		return Result{}, fmt.Errorf("gitwrite: checking for submodule paths failed: %w", err)
	} else if submodule {
		return Result{}, ErrSubmodulePathSelected
	}

	// --- Create the commit object; nothing yet references it ---------------
	commitArgs := []string{"commit-tree", treeSHA}
	if previousHeadSHA != "" {
		commitArgs = append(commitArgs, "-p", previousHeadSHA)
	}
	commitArgs = append(commitArgs, "-m", opts.Message)
	identityEnv := []string{
		"GIT_AUTHOR_NAME=" + authorName, "GIT_AUTHOR_EMAIL=" + authorEmail,
		"GIT_COMMITTER_NAME=" + authorName, "GIT_COMMITTER_EMAIL=" + authorEmail,
	}
	newSHA, err := run(ctx, dir, identityEnv, commitArgs...)
	if err != nil {
		return Result{}, fmt.Errorf("gitwrite: commit-tree failed: %w", err)
	}
	newSHA = strings.TrimSpace(newSHA)

	// --- The one call that changes what anyone else can observe ------------
	oldValueArg := previousHeadSHA // "" requires the ref to not currently exist
	if _, err := run(ctx, dir, nil, "update-ref", "-m", "project-control: commit",
		branchRefPrefix+state.Branch, newSHA, oldValueArg); err != nil {
		return Result{}, ErrHeadMoved
	}

	result := Result{
		CommitSHA: newSHA, ShortSHA: shortSHA(newSHA), PreviousHeadSHA: previousHeadSHA,
		Branch: state.Branch, FileCount: len(opts.Paths), IndexReconciled: true,
	}

	// --- Best-effort: fold the same paths into the real index --------------
	if _, err := run(ctx, dir, nil, updateArgs...); err != nil {
		result.IndexReconciled = false
	}

	return result, nil
}

func isNoopTree(ctx context.Context, dir, treeSHA, previousHeadSHA string) (bool, error) {
	if previousHeadSHA == "" {
		empty, ok := emptyTreeSHA[len(treeSHA)]
		return ok && treeSHA == empty, nil
	}
	headTree, err := run(ctx, dir, nil, "rev-parse", "--verify", "-q", previousHeadSHA+"^{tree}")
	if err != nil {
		return false, err
	}
	return strings.TrimSpace(headTree) == treeSHA, nil
}

func treeContainsSubmodule(ctx context.Context, dir, treeSHA string, paths []string) (bool, error) {
	args := append([]string{"ls-tree", "-r", treeSHA, "--"}, paths...)
	out, err := run(ctx, dir, nil, args...)
	if err != nil {
		return false, err
	}
	for _, line := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if line == "" {
			continue
		}
		fields := strings.SplitN(line, "\t", 2)
		if len(fields) != 2 {
			continue
		}
		meta := strings.Fields(fields[0])
		if len(meta) >= 2 && meta[1] == "commit" {
			return true, nil
		}
	}
	return false, nil
}

// hasUnmergedPaths reports whether the working tree currently has any
// conflicted (unmerged) path, independent of whether MERGE_HEAD happens to
// still be present.
func hasUnmergedPaths(ctx context.Context, dir string) bool {
	out, err := run(ctx, dir, nil, "status", "--porcelain=v2", "-z")
	if err != nil {
		// A status failure here is surfaced by the caller's later steps;
		// treating it as "no unmerged paths detected" would be unsafe, so the
		// conservative read is to refuse to proceed.
		return true
	}
	for _, record := range strings.Split(strings.TrimSuffix(out, "\x00"), "\x00") {
		if strings.HasPrefix(record, "u ") {
			return true
		}
	}
	return false
}

func shortSHA(sha string) string {
	if len(sha) <= 7 {
		return sha
	}
	return sha[:7]
}

// run invokes `git <args...>` with no shell, a minimal from-scratch
// environment plus any caller-supplied additions (GIT_INDEX_FILE, commit
// identity), and a bounded, discarded stderr. Every safety global gitinfo
// applies is applied here too; see the package doc for why each one matters
// for a mutating call specifically.
func run(ctx context.Context, dir string, extraEnv []string, args ...string) (string, error) {
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("gitwrite: refusing a non-absolute directory %q", dir)
	}

	finalArgs := []string{
		"--no-pager",
		"--no-optional-locks",
		"-c", "safe.directory=" + dir,
		"-c", "core.fsmonitor=false",
		"-c", "core.hooksPath=/dev/null",
		"-c", "commit.gpgsign=false",
		"-C", dir,
	}
	finalArgs = append(finalArgs, args...)

	cmd := exec.CommandContext(ctx, gitPath, finalArgs...)
	cmd.Env = append([]string{
		"HOME=/nonexistent",
		"GIT_NO_LAZY_FETCH=1",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_PAGER=",
		"PAGER=",
		"GIT_ASKPASS=",
		"LC_ALL=C",
	}, extraEnv...)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &boundedWriter{w: &stdout, limit: MaxOutputBytes}
	cmd.Stderr = &boundedWriter{w: &stderr, limit: 4096}

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return stdout.String(), nil
}

// boundedWriter discards bytes past limit rather than growing without bound.
type boundedWriter struct {
	w      *bytes.Buffer
	limit  int
	writen int
}

func (b *boundedWriter) Write(p []byte) (int, error) {
	if b.writen >= b.limit {
		return len(p), nil
	}
	remaining := b.limit - b.writen
	if len(p) > remaining {
		p = p[:remaining]
	}
	n, err := b.w.Write(p)
	b.writen += n
	return len(p), err
}
