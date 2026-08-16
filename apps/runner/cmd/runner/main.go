// Command runner is the Project Control host runner.
//
// It is a small, long-lived systemd service that exposes a fixed set of
// operations — almost all diagnostic and read-only — to the Control API over
// a Unix domain socket.
//
// Security posture — all of these are enforced, not merely intended:
//
//   - Runs as the unprivileged `project-runner` user. It refuses to start as
//     root.
//   - Listens on a Unix socket only. There is no TCP listener anywhere in the
//     binary, so it cannot be reached from the network even by mistake, and
//     the systemd unit additionally restricts it to AF_UNIX at the kernel
//     level — the runner cannot open an outbound connection either.
//   - Access is granted by group ownership of the socket (0660, group
//     project-control), which is the only credential involved.
//   - Executes no caller-supplied command, ever — there is no shell, no
//     script interpreter, and no code path that turns caller input into an
//     argv. Operations are compiled in. The one exception is the `git`
//     binary, invoked with a fixed, hardcoded argv per subcommand and only
//     against a directory that has already been validated by
//     internal/projectpath; see internal/gitinfo's package doc (reads) and
//     internal/gitwrite's package doc (the one write, project.git.commit) for
//     the full guardrail list.
//   - project.git.commit — the only operation that writes anything outside
//     the runner's own working directory — additionally requires the exact
//     project directory to appear on a second, separate, root-owned allowlist
//     (config/write-enabled-projects.conf) that is empty by default. Every
//     other project stays exactly as read-only as before this operation
//     existed, and the filesystem confinement enforced by the systemd unit
//     keeps even a write-enabled project's working tree read-only — only its
//     `.git` directory is ever writable.
//   - Every operation has a timeout, an output cap and a concurrency slot.
//   - No dependency outside the Go standard library.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/project-control/runner/internal/operations"
	"github.com/project-control/runner/internal/projectpath"
	"github.com/project-control/runner/internal/registry"
	"github.com/project-control/runner/internal/server"
)

// version is stamped at build time with -ldflags "-X main.version=...".
var version = "0.0.0-dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "runner: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		socketPath       = flag.String("socket", envOr("PC_RUNNER_SOCKET", "/run/project-control/runner.sock"), "Unix socket path")
		socketGroup      = flag.String("socket-gid", envOr("PC_RUNNER_SOCKET_GID", ""), "numeric GID permitted to use the socket")
		workingDir       = flag.String("working-dir", envOr("PC_RUNNER_WORKING_DIR", "/srv/project-control/runner"), "runner working directory")
		allowedRootsFile = flag.String("allowed-project-roots-file",
			envOr("PC_RUNNER_ALLOWED_PROJECT_ROOTS_FILE", "/srv/project-control/config/allowed-project-roots.conf"),
			"root-owned file listing allowed project roots, one absolute path per line")
		writeEnabledFile = flag.String("write-enabled-projects-file",
			envOr("PC_RUNNER_WRITE_ENABLED_PROJECTS_FILE", "/srv/project-control/config/write-enabled-projects.conf"),
			"root-owned, opt-in file listing exact project directories project.git.commit may write to, one absolute path per line (empty/missing means no project is write-enabled)")
		maxConc     = flag.Int("max-concurrent", envOrInt("PC_RUNNER_MAX_CONCURRENT", 4), "maximum concurrent operations")
		maxOutput   = flag.Int("max-output-runes", envOrInt("PC_RUNNER_MAX_OUTPUT", 8192), "maximum characters per output string")
		logLevel    = flag.String("log-level", envOr("PC_RUNNER_LOG_LEVEL", "info"), "log level: debug|info|warn|error")
		showVersion = flag.Bool("version", false, "print version and exit")
		selfCheck   = flag.Bool("check", false, "validate configuration and exit without listening")
	)
	flag.Parse()

	if *showVersion {
		fmt.Printf("project-control-runner %s\n", version)
		return nil
	}

	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		Level: parseLevel(*logLevel),
	})).With("service", "runner", "version", version)

	// --- Refuse to run as root ------------------------------------------------
	// This is the single most important invariant in the file. A runner running
	// as root would make every other control cosmetic.
	if os.Getuid() == 0 || os.Geteuid() == 0 {
		return fmt.Errorf("refusing to run as root; the runner must run as an unprivileged user (see infra/systemd/project-control-runner.service)")
	}

	// --- Socket group ---------------------------------------------------------
	if *socketGroup == "" {
		return fmt.Errorf("socket group id is required (-socket-gid or PC_RUNNER_SOCKET_GID); refusing to create a socket without a controlling group")
	}
	gid, err := strconv.Atoi(*socketGroup)
	if err != nil || gid <= 0 {
		return fmt.Errorf("socket group id must be a positive integer, got %q", *socketGroup)
	}

	// --- Working directory validation ----------------------------------------
	resolvedWorkingDir, err := validateWorkingDir(*workingDir)
	if err != nil {
		return err
	}

	// Drop any inherited umask looseness for files this process creates.
	syscall.Umask(0o077)

	// --- Allowed project roots -------------------------------------------------
	// Missing or unreadable is deliberately non-fatal: system.health and
	// runner.selftest do not depend on it, and a diagnostics-only runner is
	// more useful than a runner that refuses to start over a file it does not
	// itself manage (root/pcctl does). Every project-registration operation
	// degrades to a clear "no_allowed_roots_configured" result instead.
	allowedRoots, rootsErr := projectpath.LoadAllowedRoots(*allowedRootsFile)
	if rootsErr != nil {
		logger.Warn("allowed project roots not loaded; project registration operations are disabled until this is fixed",
			"file", *allowedRootsFile, "error", rootsErr.Error())
		allowedRoots = nil
	}

	// --- Write-enabled projects -------------------------------------------------
	// Same non-fatal treatment as allowed roots, with a different safe default:
	// a missing or unreadable file means zero write-enabled projects rather
	// than the runner refusing to start, and project.git.commit degrades to a
	// clear "write_not_enabled" result for every project until an operator
	// deliberately opts one in (see docs/repository-actions.md).
	writeEnabledProjects, writeEnabledErr := projectpath.LoadWriteEnabledProjects(*writeEnabledFile)
	if writeEnabledErr != nil {
		logger.Warn("write-enabled projects not loaded; project.git.commit is disabled for every project until this is fixed",
			"file", *writeEnabledFile, "error", writeEnabledErr.Error())
		writeEnabledProjects = nil
	}

	reg, err := registry.New(operations.All(operations.Config{
		WorkingDir:           resolvedWorkingDir,
		SocketPath:           *socketPath,
		Version:              version,
		StartedAt:            time.Now(),
		AllowedProjectRoots:  allowedRoots,
		WriteEnabledProjects: writeEnabledProjects,
	})...)
	if err != nil {
		return fmt.Errorf("cannot build operation registry: %w", err)
	}

	if *selfCheck {
		logger.Info("configuration valid",
			"socket", *socketPath,
			"allowedProjectRoots", len(allowedRoots),
			"writeEnabledProjects", len(writeEnabledProjects),
			"socketGid", gid,
			"workingDir", resolvedWorkingDir,
			"operations", reg.Names())
		return nil
	}

	srv, err := server.New(server.Options{
		SocketPath:        *socketPath,
		SocketGID:         gid,
		MaxConcurrent:     *maxConc,
		MaxOutputRunes:    *maxOutput,
		ConnectionTimeout: 30 * time.Second,
		Registry:          reg,
		Logger:            logger,
	})
	if err != nil {
		return err
	}
	defer func() { _ = srv.Close() }()

	// systemd sends SIGTERM on stop and on restart; draining in-flight work
	// avoids a truncated response to a request that was already accepted.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	logger.Info("runner ready", "uid", os.Getuid(), "gid", os.Getgid())

	if err := srv.Serve(ctx); err != nil {
		return err
	}

	logger.Info("runner stopped")
	return nil
}

// validateWorkingDir resolves the working directory and rejects anything that
// is not a real, non-symlinked directory the runner owns.
//
// Symlink rejection matters: if the working directory could be a symlink, an
// attacker who can create one redirects the runner's writes — including the
// self-test scratch file — to an arbitrary location.
func validateWorkingDir(dir string) (string, error) {
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("working directory must be an absolute path, got %q", dir)
	}

	info, err := os.Lstat(dir)
	if err != nil {
		return "", fmt.Errorf("working directory %s is not accessible: %w", dir, err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return "", fmt.Errorf("working directory %s is a symlink; refusing to use it", dir)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("working directory %s is not a directory", dir)
	}

	// The resolved path must equal the requested path: if any parent component
	// is a symlink, the effective location is not what the operator configured.
	resolved, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", fmt.Errorf("cannot resolve working directory %s: %w", dir, err)
	}

	// The runner must be able to write there, or every operation that needs
	// scratch space fails at request time instead of at start-up.
	probe := filepath.Join(resolved, ".runner-write-probe")
	f, err := os.OpenFile(probe, os.O_CREATE|os.O_WRONLY|os.O_EXCL, 0o600)
	if err != nil {
		return "", fmt.Errorf("working directory %s is not writable by uid %d: %w", resolved, os.Getuid(), err)
	}
	_ = f.Close()
	_ = os.Remove(probe)

	return resolved, nil
}

func envOr(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envOrInt(key string, fallback int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if parsed, err := strconv.Atoi(v); err == nil {
			return parsed
		}
	}
	return fallback
}

func parseLevel(level string) slog.Level {
	switch level {
	case "debug":
		return slog.LevelDebug
	case "warn":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
