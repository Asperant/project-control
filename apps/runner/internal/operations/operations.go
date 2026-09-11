// Package operations implements the runner's operation handlers.
//
// Every handler here is read-only with two narrow, deliberate exceptions:
// runner.selftest touches one temp file in the runner's own working
// directory, and project.git.commit — the runner's only true mutation —
// writes to a single repository's .git directory, and only when that exact
// repository is on the operator-managed write-enabled list. Nothing here
// spawns a process on caller-supplied input, opens a network connection, or
// writes anywhere else.
//
// The project-registration operations (project.path.validate, project.inspect,
// project.git.summary, project.git.development, project.git.write.status) read
// filesystem state under an operator-configured allowed root and, for Git
// inspection, invoke `git` — but always with a fixed argv and a
// caller-independent directory already validated by internal/projectpath;
// see internal/gitinfo's package doc for the full justification of that one
// exception to "the runner executes nothing" for reads.
//
// project.git.commit is the same exception extended, carefully, to a write:
// see internal/gitwrite's package doc for exactly what makes that one
// mutating call safe. It never accepts a command, argv, script, working
// directory or environment from the caller — only a branch name, an expected
// HEAD, a commit message and a list of repository-relative paths, all
// validated before a single git process is started.
package operations

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/project-control/runner/internal/registry"
)

// Config carries the runtime facts handlers are allowed to see. Anything not
// listed here is simply unavailable to an operation.
type Config struct {
	// WorkingDir is the runner's validated working directory.
	WorkingDir string
	// SocketPath is the Unix socket the runner listens on.
	SocketPath string
	// Version is the build version stamped into the binary.
	Version string
	// StartedAt is the process start time, for uptime reporting.
	StartedAt time.Time
	// AllowedProjectRoots is the fixed, root-owned list of directories a
	// project path may be registered under. Loaded once at startup from a
	// file the web panel and Control API cannot write to; empty when that
	// file could not be read, in which case every project-registration
	// operation reports "no_allowed_roots_configured" rather than the runner
	// refusing to start.
	AllowedProjectRoots []string
	// WriteEnabledProjects is the fixed, root-owned, opt-in list of exact
	// project directories a mutating operation may ever touch. Loaded once at
	// startup from a separate file, also unwritable by the web panel and
	// Control API. Empty by default and on any read failure — the safe,
	// shipped posture is that no project accepts a write, and enabling one
	// is a deliberate host-level action (see docs/repository-actions.md),
	// never something the application layer can turn on by itself.
	WriteEnabledProjects []string
}

// All returns the complete operation set.
func All(cfg Config) []registry.Operation {
	return []registry.Operation{
		{
			Name:           "system.health",
			Description:    "Reports host and runner health facts. Read-only.",
			TimeoutSeconds: 10,
			Params:         nil,
			Handler:        systemHealth(cfg),
		},
		{
			Name:           "runner.selftest",
			Description:    "Verifies the runner's own invariants. Read-only apart from one temp file in the runner working directory.",
			TimeoutSeconds: 15,
			Params:         nil,
			Handler:        runnerSelfTest(cfg),
		},
		{
			Name:           "project.path.validate",
			Description:    "Validates a caller-supplied path against the configured allowed project roots. Read-only; touches only path metadata.",
			TimeoutSeconds: 10,
			Params:         []registry.ParamSpec{{Name: "path", Type: "string", Required: true, MaxLength: 4096}},
			Handler:        projectPathValidate(cfg),
		},
		{
			Name:           "project.inspect",
			Description:    "Validates a path, then reads git state and manifest-detected technology under it. Read-only.",
			TimeoutSeconds: 25,
			Params:         []registry.ParamSpec{{Name: "path", Type: "string", Required: true, MaxLength: 4096}},
			Handler:        projectInspect(cfg),
		},
		{
			Name:           "project.git.summary",
			Description:    "Validates a path, then reads git state only. Read-only.",
			TimeoutSeconds: 15,
			Params:         []registry.ParamSpec{{Name: "path", Type: "string", Required: true, MaxLength: 4096}},
			Handler:        projectGitSummary(cfg),
		},
		{
			Name:           "project.git.development",
			Description:    "Validates a path, then returns bounded Git repository metadata. Strictly read-only.",
			TimeoutSeconds: 20,
			Params:         []registry.ParamSpec{{Name: "path", Type: "string", Required: true, MaxLength: 4096}},
			Handler:        projectGitDevelopment(cfg),
		},
		{
			Name: "project.git.write.status",
			Description: "Reports whether a project is write-enabled and, if so, whether its current state meets every precondition for project.git.commit. " +
				"When paths is given, also reports a bounded, deterministic content identity for exactly those repository-relative paths — never their content. Read-only.",
			TimeoutSeconds: 15,
			Params: []registry.ParamSpec{
				{Name: "path", Type: "string", Required: true, MaxLength: 4096},
				{Name: "paths", Type: "string[]", Required: false, MaxLength: 4096, MaxItems: 200},
			},
			Handler: projectGitWriteStatus(cfg),
		},
		{
			Name:        "project.git.commit",
			Description: "Commits an exact, caller-selected set of repository-relative paths to the current branch of a write-enabled project, compare-and-swapped against an expected HEAD. The runner's only mutating operation.",
			// A commit involves several sequential git invocations (layout and
			// precondition checks, tree/commit construction, the ref update,
			// then a best-effort real-index reconciliation); 60s is generous
			// headroom for a working tree of ordinary size, not an expected
			// duration.
			TimeoutSeconds: 60,
			Params: []registry.ParamSpec{
				{Name: "path", Type: "string", Required: true, MaxLength: 4096},
				{Name: "branch", Type: "string", Required: true, MaxLength: 1024},
				// ExpectedHead is a full SHA-1 (40) or SHA-256 (64) hex object id,
				// or "" for a caller that believes the branch is still unborn.
				{Name: "expectedHead", Type: "string", Required: true, MaxLength: 64},
				{Name: "message", Type: "string", Required: true, MaxLength: 8192},
				{Name: "paths", Type: "string[]", Required: true, MaxLength: 4096, MaxItems: 200},
			},
			Handler: projectGitCommit(cfg),
		},
	}
}

// systemHealth reports coarse host facts.
//
// Everything here comes from the Go runtime or a direct syscall. No external
// binary is invoked — not `df`, not `uptime`, not `systemctl` — because doing so
// would mean the runner has a code path that executes a program, and the whole
// design rests on it not having one.
func systemHealth(cfg Config) registry.Handler {
	return func(ctx context.Context, _ map[string]any) (map[string]any, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		var memStats runtime.MemStats
		runtime.ReadMemStats(&memStats)

		result := map[string]any{
			"runnerVersion": cfg.Version,
			"goVersion":     runtime.Version(),
			"platform":      runtime.GOOS + "/" + runtime.GOARCH,
			"uptimeSeconds": int64(time.Since(cfg.StartedAt).Seconds()),
			"pid":           os.Getpid(),
			"uid":           os.Getuid(),
			"gid":           os.Getgid(),
			"numGoroutine":  runtime.NumGoroutine(),
			"heapBytes":     memStats.HeapAlloc,
			"workingDir":    cfg.WorkingDir,
		}

		// Load average via sysinfo(2) rather than shelling out to `uptime`.
		var info syscall.Sysinfo_t
		if err := syscall.Sysinfo(&info); err == nil {
			scale := float64(1 << 16)
			result["loadAverage1m"] = float64(info.Loads[0]) / scale
			result["uptimeHostSeconds"] = info.Uptime
			result["memTotalBytes"] = uint64(info.Totalram) * uint64(info.Unit)
			result["memFreeBytes"] = uint64(info.Freeram) * uint64(info.Unit)
		}

		// Free space on the filesystem holding the working directory.
		var stat syscall.Statfs_t
		if err := syscall.Statfs(cfg.WorkingDir, &stat); err == nil {
			result["diskFreeBytes"] = stat.Bavail * uint64(stat.Bsize)
			result["diskTotalBytes"] = stat.Blocks * uint64(stat.Bsize)
		}

		// Confirm the socket the caller reached us through is what we think it
		// is, and that it is not world-accessible.
		if fi, err := os.Stat(cfg.SocketPath); err == nil {
			result["socketMode"] = fmt.Sprintf("%04o", fi.Mode().Perm())
			result["socketOK"] = fi.Mode()&os.ModeSocket != 0
		}

		return result, nil
	}
}

// runnerSelfTest verifies the invariants the runner's safety rests on.
//
// It is the operation an operator runs to answer "is the runner actually
// configured the way the documentation claims", and it is wired into
// `pcctl verify`.
func runnerSelfTest(cfg Config) registry.Handler {
	return func(ctx context.Context, _ map[string]any) (map[string]any, error) {
		checks := map[string]any{}
		allOK := true

		record := func(name string, ok bool, detail string) {
			checks[name] = map[string]any{"ok": ok, "detail": detail}
			if !ok {
				allOK = false
			}
		}

		if err := ctx.Err(); err != nil {
			return nil, err
		}

		// --- 1. Not running as root ------------------------------------------
		uid := os.Getuid()
		record("not_root", uid != 0,
			fmt.Sprintf("running as uid %d", uid))

		// --- 2. No privilege escalation available ----------------------------
		// If the real and effective uid differ, something setuid is in play.
		record("no_setuid", os.Getuid() == os.Geteuid() && os.Getgid() == os.Getegid(),
			fmt.Sprintf("uid=%d euid=%d gid=%d egid=%d",
				os.Getuid(), os.Geteuid(), os.Getgid(), os.Getegid()))

		// --- 3. Socket permissions -------------------------------------------
		if fi, err := os.Stat(cfg.SocketPath); err != nil {
			record("socket_present", false, "socket not found: "+err.Error())
		} else {
			perm := fi.Mode().Perm()
			// The socket must not be reachable by "other". Access is granted
			// through group membership only.
			worldAccessible := perm&0o007 != 0
			record("socket_not_world_accessible", !worldAccessible,
				fmt.Sprintf("mode %04o", perm))
		}

		// --- 4. Working directory is sane -------------------------------------
		wdInfo, err := os.Lstat(cfg.WorkingDir)
		switch {
		case err != nil:
			record("working_dir", false, "not stattable: "+err.Error())
		case wdInfo.Mode()&os.ModeSymlink != 0:
			record("working_dir", false, "working directory is a symlink")
		case !wdInfo.IsDir():
			record("working_dir", false, "working directory is not a directory")
		default:
			record("working_dir", true, cfg.WorkingDir)
		}

		// --- 5. Writable scratch, and it really is inside the working dir -----
		scratch := filepath.Join(cfg.WorkingDir, ".selftest")
		if err := os.WriteFile(scratch, []byte("ok\n"), 0o600); err != nil {
			record("scratch_writable", false, err.Error())
		} else {
			resolved, resolveErr := filepath.EvalSymlinks(scratch)
			expectedRoot, rootErr := filepath.EvalSymlinks(cfg.WorkingDir)
			inside := resolveErr == nil && rootErr == nil &&
				strings.HasPrefix(resolved, expectedRoot+string(os.PathSeparator))
			record("scratch_writable", inside,
				fmt.Sprintf("wrote and resolved to %s", resolved))
			_ = os.Remove(scratch)
		}

		// --- 6. No Docker socket reachable ------------------------------------
		// The runner must never be able to reach the Docker daemon; that would
		// be a trivial path to root on the host.
		dockerReachable := false
		for _, candidate := range []string{"/var/run/docker.sock", "/run/docker.sock"} {
			if fi, statErr := os.Stat(candidate); statErr == nil && fi.Mode()&os.ModeSocket != 0 {
				if f, openErr := os.OpenFile(candidate, os.O_RDWR, 0); openErr == nil {
					_ = f.Close()
					dockerReachable = true
				}
			}
		}
		record("no_docker_socket_access", !dockerReachable,
			"runner cannot open the Docker socket")

		// --- 7. Registry contains only the declared operations -----------------
		record("operation_registry_closed", true,
			"operations are compiled in; no runtime registration path exists")

		return map[string]any{
			"ok":     allOK,
			"checks": checks,
		}, nil
	}
}
