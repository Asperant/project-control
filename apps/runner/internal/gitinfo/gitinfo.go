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
//     symbolic-ref, show-ref, config --get-regexp, log, status, remote get-url,
//     and rev-list. None fetch, push, pull, checkout, commit, merge, or run a
//     hook.
//   - GIT_OPTIONAL_LOCKS=0 (both as an env var and via --no-optional-locks on
//     the one command that would otherwise refresh the index's stat cache) is
//     what keeps `git status` from writing to .git/index — this environment
//     genuinely never mutates the repository.
//   - The environment passed to the child is built from scratch, not
//     inherited: only a small fixed set of locale and GIT_* variables. No
//     credential helper, no SSH command, no pager, no editor.
//   - Every command is time-boxed by the caller's context and its output is
//     read through a bounded reader.
//   - The child process inherits the runner's own systemd sandbox (seccomp
//     filters and namespace restrictions apply across exec), including
//     RestrictAddressFamilies=AF_UNIX — so even a bug here could not open a
//     network connection.
package gitinfo

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// MaxOutputBytes bounds how much of a git command's stdout is read. Every
// command here produces at most a handful of lines; this is generous
// headroom, not an expected ceiling.
const MaxOutputBytes = 256 * 1024

const (
	maxChangedFiles      = 200
	maxRecentCommits     = 20
	maxStatusRecordBytes = 16 * 1024
)

// commitHashPattern accepts Git's complete SHA-1 and SHA-256 object IDs.
var commitHashPattern = regexp.MustCompile(`^(?:[0-9a-f]{40}|[0-9a-f]{64})$`)

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

// Development is the bounded, metadata-only repository view returned by the
// project.git.development operation. It intentionally contains no diff or
// file contents.
type Development struct {
	Repository    Repository
	Head          Head
	WorkingTree   WorkingTree
	Files         []ChangedFile
	RecentCommits []Commit
	Remote        *Origin
	GitHub        GitHub
}

type Repository struct {
	Available    bool
	IsRepository bool
	ErrorCode    string
}

type Head struct {
	SHA      string
	ShortSHA string
	Branch   string
	Detached bool
	Unborn   bool
}

type WorkingTree struct {
	Clean             bool
	StagedCount       int
	UnstagedCount     int
	UntrackedCount    int
	ConflictedCount   int
	TotalChangedCount int
	FilesTruncated    bool
}

type ChangedFile struct {
	Path      string
	OldPath   string
	State     string
	Staged    bool
	Unstaged  bool
	Untracked bool
	// Size and ModifiedAt describe the *working tree* file at inspection
	// time. Both are "" / 0 when unavailable — State == "deleted", or a stat
	// race between the status read and this follow-up lstat. Populated by a
	// bounded post-pass in InspectDevelopment rather than during porcelain
	// parsing, since only a caller that already asked for full Development
	// detail (not the lighter Summary) needs it.
	//
	// This exists because Git's own status categories (staged/unstaged/state)
	// are coarse: two edits to the same file, made seconds apart, both land
	// as "modified, unstaged" with no way to tell them apart from status
	// alone. A consumer fingerprinting "has this exact file changed since I
	// last looked" — see the Control API's Repository Actions plan staleness
	// check — needs something finer-grained than the status category.
	Size       int64
	ModifiedAt string // RFC3339Nano; "" when unavailable
}

type Commit struct {
	SHA        string
	ShortSHA   string
	Subject    string
	AuthorName string
	AuthoredAt string
}

type Origin struct {
	Name            string
	RawURL          string
	Host            string
	Owner           string
	Repository      string
	TrackingBranch  string
	Ahead           *int
	Behind          *int
	ComparisonBasis string
}

type GitHub struct {
	Detected   bool
	Configured bool
	Status     string
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

// InspectDevelopment returns a safe machine result for every observational
// failure. Only an invalid caller contract (a non-absolute directory) is an
// error; normal Git absence/failure is represented in Repository.ErrorCode.
func InspectDevelopment(ctx context.Context, dir string) (Development, error) {
	result := Development{
		Repository:  Repository{Available: Available()},
		WorkingTree: WorkingTree{Clean: true},
		GitHub:      GitHub{Status: "unsupported"},
	}
	if !filepath.IsAbs(dir) {
		return Development{}, errors.New("gitinfo: dir must be an absolute path")
	}
	if !Available() {
		result.Repository.ErrorCode = "git_unavailable"
		return result, nil
	}

	inside, err := run(ctx, dir, "rev-parse", "--is-inside-work-tree")
	if err != nil || strings.TrimSpace(inside) != "true" {
		result.Repository.ErrorCode = "not_repository"
		return result, nil
	}
	result.Repository.IsRepository = true

	if err := inspectStatus(ctx, dir, &result); err != nil {
		result.Repository.ErrorCode = "inspection_failed"
		return result, nil
	}
	populateWorkingTreeStat(dir, result.Files)
	result.RecentCommits = recentCommits(ctx, dir)
	result.Remote = origin(ctx, dir, result.Head.Unborn)
	if result.Remote != nil && result.Remote.Host == "github.com" {
		result.GitHub = GitHub{Detected: true, Configured: false, Status: "not_configured"}
	}
	return result, nil
}

// populateWorkingTreeStat fills Size/ModifiedAt for each already-parsed
// changed file by lstat-ing its working-tree path. Best-effort: a file that
// no longer exists (deleted, or a race with a concurrent change) simply keeps
// the zero values rather than failing the whole inspection. A symlink is
// stat-ed, not followed — its target's size is irrelevant to "did this path
// change", and following it could escape the repository.
func populateWorkingTreeStat(dir string, files []ChangedFile) {
	for i := range files {
		if files[i].State == "deleted" {
			continue
		}
		info, err := os.Lstat(filepath.Join(dir, files[i].Path))
		if err != nil {
			continue
		}
		files[i].Size = info.Size()
		files[i].ModifiedAt = info.ModTime().UTC().Format(time.RFC3339Nano)
	}
}

func failedDevelopment() Development {
	return Development{
		Repository:  Repository{Available: true, IsRepository: true, ErrorCode: "inspection_failed"},
		WorkingTree: WorkingTree{Clean: true},
		GitHub:      GitHub{Status: "unsupported"},
	}
}

func parsePorcelainV2(raw string, result *Development) bool {
	tokens := strings.Split(strings.TrimSuffix(raw, "\x00"), "\x00")
	i := 0
	return parsePorcelainV2Records(func() (string, bool) {
		if i >= len(tokens) || (len(tokens) == 1 && tokens[0] == "") {
			return "", false
		}
		record := tokens[i]
		i++
		return record, true
	}, result)
}

func parsePorcelainV2Records(next func() (string, bool), result *Development) bool {
	for {
		record, ok := next()
		if !ok {
			break
		}
		switch {
		case strings.HasPrefix(record, "# branch.oid "):
			oid := strings.TrimPrefix(record, "# branch.oid ")
			if commitHashPattern.MatchString(oid) {
				result.Head.SHA = oid
				result.Head.ShortSHA = shortSHA(oid)
			} else if oid == "(initial)" {
				result.Head.Unborn = true
			}
		case strings.HasPrefix(record, "# branch.head "):
			head := strings.TrimPrefix(record, "# branch.head ")
			if head == "(detached)" {
				result.Head.Detached = true
			} else if head != "(unknown)" {
				result.Head.Branch = safeSingleLine(head)
			}
		case strings.HasPrefix(record, "1 "):
			fields := strings.SplitN(record, " ", 9)
			if len(fields) == 9 {
				if !addChangedFile(result, fields[8], "", fields[1]) {
					return false
				}
			}
		case strings.HasPrefix(record, "2 "):
			fields := strings.SplitN(record, " ", 10)
			if len(fields) == 10 {
				oldPath, exists := next()
				if !exists {
					return false
				}
				if !addChangedFile(result, fields[9], oldPath, fields[1]) {
					return false
				}
			}
		case strings.HasPrefix(record, "u "):
			fields := strings.SplitN(record, " ", 11)
			if len(fields) == 11 {
				if !addChangedFile(result, fields[10], "", fields[1]) {
					return false
				}
			}
		case strings.HasPrefix(record, "? "):
			if !addChangedFile(result, strings.TrimPrefix(record, "? "), "", "??") {
				return false
			}
		}
	}
	result.WorkingTree.Clean = result.WorkingTree.TotalChangedCount == 0
	result.WorkingTree.FilesTruncated = result.WorkingTree.TotalChangedCount > len(result.Files)
	return true
}

// inspectStatus streams NUL-delimited porcelain records so even a very large
// working tree can be fully counted while only the first maxChangedFiles paths
// are retained. Other Git commands remain subject to MaxOutputBytes.
func inspectStatus(ctx context.Context, dir string, result *Development) error {
	cmd, err := gitCommand(ctx, dir, "status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z")
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &boundedWriter{w: &stderr, limit: 4096}
	if err := cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 4096), maxStatusRecordBytes)
	scanner.Split(splitNUL)
	next := func() (string, bool) {
		if !scanner.Scan() {
			return "", false
		}
		return scanner.Text(), true
	}
	valid := parsePorcelainV2Records(next, result)
	if !valid || scanner.Err() != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return errors.New("invalid Git status output")
	}
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("git status: %w", err)
	}
	return nil
}

func splitNUL(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if index := bytes.IndexByte(data, 0); index >= 0 {
		return index + 1, data[:index], nil
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}

func addChangedFile(result *Development, path, oldPath, xy string) bool {
	if !safeRepositoryRelativePath(path) || (oldPath != "" && !safeRepositoryRelativePath(oldPath)) {
		return false
	}
	path, oldPath = safeSingleLine(path), safeSingleLine(oldPath)
	file := ChangedFile{Path: path, OldPath: oldPath}
	if xy == "??" {
		file.State = "untracked"
		file.Untracked = true
		result.WorkingTree.UntrackedCount++
	} else {
		x, y := byte('.'), byte('.')
		if len(xy) >= 2 {
			x, y = xy[0], xy[1]
		}
		file.Staged = x != '.'
		file.Unstaged = y != '.'
		if file.Staged {
			result.WorkingTree.StagedCount++
		}
		if file.Unstaged {
			result.WorkingTree.UnstagedCount++
		}
		file.State = changeState(x, y, oldPath != "")
		if isConflictXY(xy) {
			file.State = "conflicted"
			result.WorkingTree.ConflictedCount++
		}
	}
	result.WorkingTree.TotalChangedCount++
	if len(result.Files) < maxChangedFiles {
		result.Files = append(result.Files, file)
	}
	return true
}

func safeRepositoryRelativePath(path string) bool {
	if path == "" || filepath.IsAbs(path) || strings.HasPrefix(path, "/") {
		return false
	}
	for _, segment := range strings.Split(strings.ReplaceAll(path, "\\", "/"), "/") {
		if segment == ".." {
			return false
		}
	}
	return true
}

func safeSingleLine(value string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, value)
}

func safeBoundedSingleLine(value string, maxBytes int) string {
	value = safeSingleLine(value)
	if len(value) <= maxBytes {
		return value
	}
	return strings.ToValidUTF8(value[:maxBytes], "")
}

func changeState(x, y byte, renamed bool) string {
	if renamed || x == 'R' || y == 'R' || x == 'C' || y == 'C' {
		return "renamed"
	}
	if x == 'D' || y == 'D' {
		return "deleted"
	}
	if x == 'A' || y == 'A' {
		return "added"
	}
	if x == 'T' || y == 'T' {
		return "type_changed"
	}
	return "modified"
}

func isConflictXY(xy string) bool {
	switch xy {
	case "DD", "AU", "UD", "UA", "DU", "AA", "UU":
		return true
	default:
		return false
	}
}

func shortSHA(sha string) string {
	if len(sha) <= 7 {
		return sha
	}
	return sha[:7]
}

func recentCommits(ctx context.Context, dir string) []Commit {
	const format = "%H%x00%s%x00%an%x00%aI"
	out, err := run(ctx, dir, "log", "-z", "-n", strconv.Itoa(maxRecentCommits), "--format="+format, "--")
	if err != nil {
		return nil
	}
	commits := make([]Commit, 0, maxRecentCommits)
	fields := strings.Split(strings.TrimSuffix(out, "\x00"), "\x00")
	for i := 0; i+3 < len(fields); i += 4 {
		if !commitHashPattern.MatchString(fields[i]) {
			continue
		}
		if _, err := time.Parse(time.RFC3339, fields[i+3]); err != nil {
			continue
		}
		commits = append(commits, Commit{SHA: fields[i], ShortSHA: shortSHA(fields[i]), Subject: safeBoundedSingleLine(fields[i+1], 1000), AuthorName: safeBoundedSingleLine(fields[i+2], 500), AuthoredAt: fields[i+3]})
	}
	return commits
}

func origin(ctx context.Context, dir string, unborn bool) *Origin {
	raw, err := run(ctx, dir, "remote", "get-url", "origin")
	if err != nil {
		return nil
	}
	safe, host, owner, repository, _ := parseRemote(strings.TrimSpace(raw))
	result := &Origin{Name: "origin", RawURL: safe, Host: host, Owner: owner, Repository: repository, ComparisonBasis: "none"}
	upstream, err := run(ctx, dir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}")
	if err != nil {
		return result
	}
	result.TrackingBranch = safeSingleLine(strings.TrimSpace(upstream))
	result.ComparisonBasis = "local_tracking_ref"
	if unborn {
		return result
	}
	if _, err := run(ctx, dir, "rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"); err != nil {
		result.ComparisonBasis = "none"
		result.TrackingBranch = ""
		return result
	}
	counts, err := run(ctx, dir, "rev-list", "--left-right", "--count", "HEAD...@{upstream}")
	if err != nil {
		result.ComparisonBasis = "none"
		return result
	}
	parts := strings.Fields(counts)
	if len(parts) == 2 {
		ahead, aerr := strconv.Atoi(parts[0])
		behind, berr := strconv.Atoi(parts[1])
		if aerr == nil && berr == nil {
			result.Ahead, result.Behind = &ahead, &behind
		} else {
			result.ComparisonBasis = "none"
		}
	} else {
		result.ComparisonBasis = "none"
	}
	return result
}

var scpRemotePattern = regexp.MustCompile(`^(?:[^@/:\s]+@)?([^/:\s]+):([^\s]+)$`)

func parseRemote(raw string) (safe, host, owner, repository string, ok bool) {
	if raw == "" || strings.ContainsAny(raw, "\r\n\x00") {
		return "", "", "", "", false
	}
	if !strings.Contains(raw, "://") {
		if match := scpRemotePattern.FindStringSubmatch(raw); match != nil {
			host = strings.ToLower(match[1])
			owner, repository, ok = remotePathParts(match[2])
			if !ok {
				return "", "", "", "", false
			}
			return "git@" + host + ":" + owner + "/" + repository + ".git", host, owner, repository, true
		}
		return "", "", "", "", false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return "", "", "", "", false
	}
	switch strings.ToLower(parsed.Scheme) {
	case "https", "http", "ssh", "git":
	default:
		return "", "", "", "", false
	}
	host = strings.ToLower(parsed.Hostname())
	owner, repository, ok = remotePathParts(parsed.EscapedPath())
	if !ok {
		return "", "", "", "", false
	}
	clean := &url.URL{Scheme: strings.ToLower(parsed.Scheme), Host: parsed.Host, Path: "/" + owner + "/" + repository + ".git"}
	return clean.String(), host, owner, repository, true
}

func remotePathParts(rawPath string) (owner, repository string, ok bool) {
	path, err := url.PathUnescape(strings.Trim(rawPath, "/"))
	if err != nil {
		return "", "", false
	}
	parts := strings.Split(path, "/")
	if len(parts) != 2 || !safeRemoteSegment(parts[0]) || !safeRemoteSegment(parts[1]) {
		return "", "", false
	}
	repository = strings.TrimSuffix(parts[1], ".git")
	if repository == "" {
		return "", "", false
	}
	return parts[0], repository, true
}

func safeRemoteSegment(segment string) bool {
	if segment == "" || segment == "." || segment == ".." || strings.ContainsAny(segment, "\\?#") {
		return false
	}
	for _, r := range segment {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	return true
}

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
	cmd, err := gitCommand(ctx, dir, args...)
	if err != nil {
		return "", err
	}

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &boundedWriter{w: &stdout, limit: MaxOutputBytes}
	cmd.Stderr = &boundedWriter{w: &stderr, limit: 4096}

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w", strings.Join(args, " "), err)
	}
	return stdout.String(), nil
}

func gitCommand(ctx context.Context, dir string, args ...string) (*exec.Cmd, error) {
	// dir is guaranteed absolute (and therefore cannot be interpreted as a
	// flag) by every caller in this package, all of which receive it from
	// projectpath.Validate.
	if !filepath.IsAbs(dir) {
		return nil, fmt.Errorf("gitinfo: refusing a non-absolute directory %q", dir)
	}

	// All invocations receive the same safety globals. In particular the
	// command-line core.fsmonitor override prevents repository-local config
	// from spawning an arbitrary fsmonitor hook during status inspection.
	//
	// safe.directory=dir is scoped to this exact, already-validated directory
	// via -c (not a persisted, wildcarded global config): dir is always the
	// absolute Canonical path projectpath.Validate produced, so this cannot be
	// used to bless an arbitrary path. It exists because the runner's uid
	// (project-runner) differs from the filesystem owner of every registered
	// project by design, and git >= 2.35.2 refuses to read a repository whose
	// directory it does not own ("detected dubious ownership") unless the
	// directory is explicitly marked safe. Without this, every invocation in
	// this file fails closed on a correctly configured host.
	finalArgs := []string{
		"--no-pager",
		"--no-optional-locks",
		"-c", "safe.directory=" + dir,
		"-c", "core.fsmonitor=false",
		"-c", "core.hooksPath=/dev/null",
		"-C", dir,
	}
	if len(args) >= 2 && args[0] == "-C" {
		args = args[2:]
	}
	finalArgs = append(finalArgs, args...)

	cmd := exec.CommandContext(ctx, gitPath, finalArgs...)
	// A from-scratch environment: no inherited credential helpers, SSH
	// command, pager, editor, or proxy configuration.
	cmd.Env = []string{
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
	}
	return cmd, nil
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
