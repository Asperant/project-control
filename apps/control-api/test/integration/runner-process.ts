import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Builds and runs the *real* Go runner binary for integration tests, rather
 * than mocking `RunnerClient`. This is deliberate, matching the rest of this
 * test suite (a real throwaway PostgreSQL container, a real Fastify app): the
 * project-registration feature's entire point is what the runner does with a
 * caller-supplied path, and a mock would paper over exactly that.
 */

export type RunnerProcess = {
  socketPath: string;
  allowedRoot: string;
  /** Canonical, pre-created directories the runner was started with on its
   * write-enabled list, keyed by the name passed in `writeEnabledProjectNames`.
   * Empty unless that option was used. */
  writeEnabledPaths: Record<string, string>;
  stop: () => Promise<void>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..');
const RUNNER_MODULE_DIR = path.join(REPO_ROOT, 'apps', 'runner');

let cachedBinaryPath: string | null = null;

async function buildRunnerBinary(): Promise<string> {
  if (cachedBinaryPath) return cachedBinaryPath;
  const outDir = await mkdtemp(path.join(tmpdir(), 'pc-test-runner-bin-'));
  const outPath = path.join(outDir, 'project-control-runner');
  await exec('go', ['build', '-o', outPath, './cmd/runner'], { cwd: RUNNER_MODULE_DIR });
  cachedBinaryPath = outPath;
  return outPath;
}

async function waitForSocket(socketPath: string, timeoutMs = 10_000): Promise<void> {
  const { access } = await import('node:fs/promises');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`runner socket ${socketPath} did not appear within ${timeoutMs} ms`);
}

export type StartRunnerOptions = {
  /** Directory names (created as direct children of the generated allowed
   * root, before the runner starts) to place on the runner's write-enabled
   * list — see internal/gitwrite. Only project.git.commit consults this;
   * every read-only operation is unaffected by it. */
  writeEnabledProjectNames?: string[];
};

/** Starts a real runner process with a single allowed root under a fresh temp directory. */
export async function startRunnerProcess(options: StartRunnerOptions = {}): Promise<RunnerProcess> {
  const binaryPath = await buildRunnerBinary();

  const runtimeDir = await mkdtemp(path.join(tmpdir(), 'pc-test-runner-run-'));
  const workingDir = await mkdtemp(path.join(tmpdir(), 'pc-test-runner-work-'));
  const allowedRoot = await mkdtemp(path.join(tmpdir(), 'pc-test-allowed-root-'));

  const rootsFile = path.join(runtimeDir, 'allowed-roots.conf');
  await writeFile(rootsFile, `${allowedRoot}\n`, 'utf8');

  const writeEnabledPaths: Record<string, string> = {};
  for (const name of options.writeEnabledProjectNames ?? []) {
    const dir = path.join(allowedRoot, name);
    await mkdir(dir, { recursive: true });
    // Resolved exactly the way projectpath.Validate resolves a live path
    // (EvalSymlinks), so the runner's stored entry and the request-time
    // canonical path are guaranteed to match byte-for-byte.
    writeEnabledPaths[name] = await realpath(dir);
  }
  const writeEnabledFile = path.join(runtimeDir, 'write-enabled-projects.conf');
  await writeFile(writeEnabledFile, `${Object.values(writeEnabledPaths).join('\n')}\n`, 'utf8');

  const socketPath = path.join(runtimeDir, 'runner.sock');
  const gid = typeof process.getgid === 'function' ? process.getgid() : undefined;
  if (!gid) throw new Error('process.getgid() is unavailable; runner integration tests require a POSIX platform');

  const child = spawn(
    binaryPath,
    [
      '--socket', socketPath,
      '--socket-gid', String(gid),
      '--working-dir', workingDir,
      '--allowed-project-roots-file', rootsFile,
      '--write-enabled-projects-file', writeEnabledFile,
      '--max-concurrent', '4',
      '--log-level', 'error',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const exited = new Promise<never>((_, reject) => {
    child.on('exit', (code) => {
      reject(new Error(`runner process exited early with code ${code}: ${stderr}`));
    });
  });

  await Promise.race([waitForSocket(socketPath), exited]).catch((err) => {
    throw err;
  });

  return {
    socketPath,
    allowedRoot,
    writeEnabledPaths,
    stop: async () => {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        child.once('exit', resolve);
        setTimeout(resolve, 2000);
      });
      await rm(runtimeDir, { recursive: true, force: true }).catch(() => {});
      await rm(workingDir, { recursive: true, force: true }).catch(() => {});
      await rm(allowedRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}
