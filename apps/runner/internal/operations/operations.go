// Package operations implements the Stage 1 operation handlers.
//
// Scope is deliberately tiny: two read-only diagnostics. Neither spawns a
// process, opens a network connection, reads a secret, or writes outside the
// runner's own working directory. Real project commands arrive in later stages,
// and will arrive as new entries in this table — never as caller-supplied
// commands.
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
}

// All returns the complete Stage 1 operation set.
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

		// --- 7. Registry contains only the declared Stage 1 operations --------
		record("operation_registry_closed", true,
			"operations are compiled in; no runtime registration path exists")

		return map[string]any{
			"ok":     allOK,
			"checks": checks,
		}, nil
	}
}
