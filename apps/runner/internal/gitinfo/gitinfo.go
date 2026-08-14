// Package gitinfo reads read-only git facts about a directory that has
// already been validated by projectpath.Validate.
//
// # Why this shells out to `git` at all
//
// Every other operation in this runner avoids process execution entirely (see
// the package doc on cmd/runner/main.go). Git state is the one exception, and
// it is deliberate: a correct, from-scratch reimplementation of `git status`
// — which requires parsing the binary index format and replicating gitignore
// semantics — is real parsing of a complex, versioned on-disk format, and a
// subtly wrong reimplementation would silently misreport a project's state.
// Shelling out to the real `git` binary, built and maintained by people whose
// job is exactly that correctness, is the safer choice here, provided the
// invocation itself cannot become a caller-controlled command. It is made so
// by every rule in this file:
//
//   - No shell is ever involved (os/exec with an argv slice, never a joined
//     string passed to /bin/sh).
//   - Every argv is a fixed literal declared in this file. The only variable
//     component of any invocation is the directory, and it is always the
//     `Canonical` path already produced by projectpath.Validate — an absolute
//     path (so it can never be mistaken for a flag) that has already been
//     confirmed to be a real, existing directory under an allowed root.
//   - Only read-only, non-hook-invoking subcommands are used: rev-parse,
//     symbolic-ref, show-ref, config --get-regexp, log, and status with
//     --no-optional-locks. None of these fetch, push, pull, checkout, commit,
//     merge, or run a hook.
//   - GIT_OPTIONAL_LOCKS=0 (both as an env var and via --no-optional-locks on
//     the one command that would otherwise refresh the index's stat cache) is
//     what keeps `git status` from writing to .git/index — this environment
//     genuinely never mutates the repository.
//   - The environment passed to the child is built from scratch, not
//     inherited: PATH plus a small fixed set of GIT_* variables. No
//     credential helper, no SSH command, no pager, no editor.
//   - Every command is time-boxed by the caller's context and its output is
//     read through a bounded reader.
//   - The child process inherits the runner's own systemd sandbox (seccomp
//     filters and namespace restrictions apply across exec), including
//     RestrictAddressFamilies=AF_UNIX — so even a bug here could not open a
//     network connection.
package gitinfo

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// MaxOutputBytes bounds how much of a git command's stdout is read. Every
// command here produces at most a handful of lines; this is generous
// headroom, not an expected ceiling.
const MaxOutputBytes = 256 * 1024

// commitHashPattern matches a full 40-character hex SHA-1 object id. Git has
// not defaulted to SHA-256 object ids in any released version this runner
// targets, so this is deliberately not made configurable.
var commitHashPattern = regexp.MustCompile(`^[0-9a-f]{40}$`)

// Remote is one sanitised remote entry.
type Remote struct {
	Name string
	URL  string
}

// Summary is everything this package reports about a repository.
type Summary struct {
	Present                 bool
	TopLevelPath            string
	Remotes                 []Remote
	ActiveBranch            string // "" when detached or unresolvable
	Detached                bool
	DefaultBranch           string // "" when unknown
	DefaultBranchConfidence string // "known" | "inferred" | "unknown"
	LastCommitHash          string
	LastCommitShortHash     string
	LastCommitAtRFC3339     string
	LastCommitSubject       string
	IsDirty                 bool
	ModifiedCount           int
	UntrackedCount          int
}

// gitPath is resolved once. A missing git binary is not fatal to the runner —
// callers degrade to "git information unavailable" rather than failing every
// inspection.
var gitPath = func() string {
	p, err := exec.LookPath("git")
	if err != nil {
		return ""
	}
	return p
}()

// Available reports whether a usable `git` binary was found at startup.
func Available() bool { return gitPath != "" }

// Summarise inspects dir, which must already be a validated, canonical,
// existing directory. Returns Summary{Present: false} (no error) when dir is
// not inside a git working tree — that is a normal, expected outcome, not a
// failure.
func Summarise(ctx context.Context, dir string) (Summary, error) {
	if !Available() {
		return Summary{}, errors.New("git binary not available")
	}
	if !filepath.IsAbs(dir) {
		return Summary{}, errors.New("gitinfo: dir must be an absolute path")
	}

	topLevel, err := run(ctx, dir, "rev-parse", "--show-toplevel")
	if err != nil {
		// No repository here (or dir is inside .git, or git is otherwise unable
		// to identify a work tree). Every one of these collapses to "not a git
		// project" — the caller does not need to distinguish them.
		return Summary{Present: false}, nil
	}
	summary := Summary{
		Present:      true,
		TopLevelPath: strings.TrimSpace(topLevel),
	}

	if branch, detached := activeBranch(ctx, dir); detached {
		summary.Detached = true
	} else {
		summary.ActiveBranch = branch
	}

	summary.DefaultBranch, summary.DefaultBranchConfidence = defaultBranch(ctx, dir)
	summary.Remotes = remotes(ctx, dir)

	if hash, short, at, subject, ok := lastCommit(ctx, dir); ok {
		summary.LastCommitHash = hash
		summary.LastCommitShortHash = short
		summary.LastCommitAtRFC3339 = at
		summary.LastCommitSubject = subject
	}

	dirty, modified, untracked := workingTreeStatus(ctx, dir)
	summary.IsDirty = dirty
	summary.ModifiedCount = modified
	summary.UntrackedCount = untracked

	return summary, nil
}

func activeBranch(ctx context.Context, dir string) (branch string, detached bool) {
	// symbolic-ref fails exactly when HEAD is detached; that is the reliable
	// signal, rather than pattern-matching rev-parse's "HEAD" fallback value.
	if _, err := run(ctx, dir, "symbolic-ref", "-q", "HEAD"); err != nil {
		return "", true
	}
	out, err := run(ctx, dir, "rev-parse", "--abbrev-ref", "HEAD")
	if err != nil {
		return "", true
	}
	name := strings.TrimSpace(out)
	if name == "" || name == "HEAD" {
		return "", true
	}
	return name, false
}

// defaultBranch is inferred from local ref state only — never from the
// network. A local origin/HEAD symref is the only source treated as
// authoritative ("known"); anything else is at best a guess ("inferred") and
// is reported as such rather than presented as fact.
func defaultBranch(ctx context.Context, dir string) (name, confidence string) {
	if out, err := run(ctx, dir, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"); err == nil {
		ref := strings.TrimSpace(out)
		const prefix = "refs/remotes/origin/"
		if strings.HasPrefix(ref, prefix) {
			return strings.TrimPrefix(ref, prefix), "known"
		}
	}
	for _, candidate := range []string{"main", "master"} {
		if _, err := run(ctx, dir, "show-ref", "--verify", "-q", "refs/heads/"+candidate); err == nil {
			return candidate, "inferred"
		}
	}
	return "", "unknown"
}

// remoteURLLine matches one line of `git config --get-regexp`, e.g.
// "remote.origin.url https://example.com/org/repo.git".
var remoteURLLine = regexp.MustCompile(`^remote\.([^.\s]+)\.url\s+(.+)$`)

func remotes(ctx context.Context, dir string) []Remote {
	out, err := run(ctx, dir, "config", "--get-regexp", `^remote\..*\.url$`)
	if err != nil {
		return nil
	}
	var result []Remote
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimRight(line, "\r")
		if line == "" {
			continue
		}
		m := remoteURLLine.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		result = append(result, Remote{Name: m[1], URL: sanitiseRemoteURL(m[2])})
	}
	return result
}

// credentialInURL matches the userinfo component of a URL: scheme://user[:pass]@host/...
var credentialInURL = regexp.MustCompile(`^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/@\s]+@`)

// sanitiseRemoteURL strips embedded credentials from an https/http remote URL
// before it ever leaves the runner. SSH remotes (git@host:org/repo.git) carry
// no password-shaped credential in this form and are passed through as-is.
func sanitiseRemoteURL(raw string) string {
	return credentialInURL.ReplaceAllString(raw, "$1")
}

// commitFieldSep is a control character that cannot appear in any of the
// fields it separates, so splitting on it is unambiguous regardless of commit
// message content.
const commitFieldSep = "\x1f"

func lastCommit(ctx context.Context, dir string) (hash, short, atRFC3339, subject string, ok bool) {
	format := "%H" + commitFieldSep + "%h" + commitFieldSep + "%cI" + commitFieldSep + "%s"
	out, err := run(ctx, dir, "log", "-1", "--format="+format, "--")
	if err != nil {
		return "", "", "", "", false
	}
	fields := strings.SplitN(strings.TrimRight(out, "\n"), commitFieldSep, 4)
	if len(fields) != 4 {
		return "", "", "", "", false
	}
	if !commitHashPattern.MatchString(fields[0]) {
		return "", "", "", "", false
	}
	return fields[0], fields[1], fields[2], fields[3], true
}

// workingTreeStatus parses `git status --porcelain=v1 -z` output. NUL-
// terminated records avoid any ambiguity from filenames containing newlines.
// A rename/copy record ("R"/"C" in the first column) carries two paths per
// record; the second is consumed and discarded, since only counts are
// reported.
func workingTreeStatus(ctx context.Context, dir string) (dirty bool, modified, untracked int) {
	out, err := runRaw(ctx, dir, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal", "-z")
	if err != nil {
		return false, 0, 0
	}
	tokens := strings.Split(strings.TrimSuffix(out, "\x00"), "\x00")
	for i := 0; i < len(tokens); i++ {
		entry := tokens[i]
		if entry == "" {
			continue
		}
		if len(entry) < 3 {
			continue
		}
		status := entry[:2]
		if status == "??" || status == "!!" {
			untracked++
		} else {
			modified++
		}
		if status[0] == 'R' || status[0] == 'C' {
			// The old path follows as a second NUL-delimited token.
			i++
		}
	}
	return modified+untracked > 0, modified, untracked
}

// run invokes `git -C dir <args...>` and returns trimmed stdout.
func run(ctx context.Context, dir string, args ...string) (string, error) {
	full := append([]string{"-C", dir}, args...)
	return runRaw(ctx, dir, full...)
}

// runRaw invokes `git <args...>` with no shell, a minimal environment, and a
// bounded, discarded stderr. dir is accepted only so every call site visibly
// carries the directory it operates on; args must already include "-C dir"
// or an equivalent when directory scoping is required (workingTreeStatus
// needs flags before -C is conventional to place, so it builds its own argv).
func runRaw(ctx context.Context, dir string, args ...string) (string, error) {
	// dir is guaranteed absolute (and therefore cannot be interpreted as a
	// flag) by every caller in this package, all of which receive it from
	// projectpath.Validate.
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("gitinfo: refusing a non-absolute directory %q", dir)
	}

	finalArgs := args
	if len(finalArgs) == 0 || finalArgs[0] != "-C" {
		finalArgs = append([]string{"-C", dir}, args...)
	}

	cmd := exec.CommandContext(ctx, gitPath, finalArgs...)
	// A from-scratch environment: no inherited credential helpers, SSH
	// command, pager, editor, or proxy configuration.
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=/nonexistent",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_PAGER=cat",
		"GIT_ASKPASS=",
		"LC_ALL=C",
	}

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
	w      io.Writer
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
