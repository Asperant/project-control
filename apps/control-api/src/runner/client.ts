import { connect, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Client for the host runner.
 *
 * Transport is a Unix domain socket at /run/project-control/runner.sock, mounted
 * read-write into this container and owned by the `project-control` group. There
 * is no TCP listener anywhere in the runner, so the attack surface is limited to
 * processes that already have filesystem access to that socket.
 *
 * The wire format is newline-delimited JSON: one request object, one response
 * object, connection closed. No framing ambiguity, no keep-alive state.
 */

export const runnerOperationSchema = z.enum([
  'system.health',
  'runner.selftest',
  'project.path.validate',
  'project.inspect',
  'project.git.summary',
  'project.git.development',
  'project.git.write.status',
  'project.git.commit',
]);
export type RunnerOperation = z.infer<typeof runnerOperationSchema>;

export const runnerResponseSchema = z.object({
  requestId: z.string(),
  operation: z.string(),
  ok: z.boolean(),
  /** Structured result; shape depends on the operation. */
  result: z.record(z.string(), z.unknown()).default({}),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .nullable()
    .default(null),
  durationMs: z.number().nonnegative(),
  truncated: z.boolean().default(false),
});
export type RunnerResponse = z.infer<typeof runnerResponseSchema>;

export class RunnerUnavailableError extends Error {
  constructor(detail: string) {
    super(`Runner unavailable: ${detail}`);
    this.name = 'RunnerUnavailableError';
  }
}

export type RunnerClientOptions = {
  socketPath: string;
  timeoutMs: number;
  /** Guards the API against a slow runner consuming all its sockets. */
  maxConcurrent?: number;
  /** Ceiling on the response we will buffer, mirroring the runner's own cap. */
  maxResponseBytes?: number;
};

export class RunnerClient {
  private inFlight = 0;
  private readonly maxConcurrent: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: RunnerClientOptions) {
    this.maxConcurrent = options.maxConcurrent ?? 4;
    this.maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
  }

  /**
   * Invokes a named operation.
   *
   * Note what this signature does *not* accept: no command string, no argv, no
   * script body, no working directory, no environment. The only thing that
   * crosses the socket is an operation name from a closed enum plus a JSON
   * parameter object that the runner validates against that operation's schema.
   * There is no code path — here or in the runner — that turns caller input into
   * an executable.
   */
  async invoke(
    operation: RunnerOperation,
    params: Record<string, unknown> = {},
    requestId: string = randomUUID(),
  ): Promise<RunnerResponse> {
    if (this.inFlight >= this.maxConcurrent) {
      throw new RunnerUnavailableError('too many concurrent runner requests');
    }
    // Reject anything not in the enum before it reaches the socket.
    const parsedOperation = runnerOperationSchema.parse(operation);

    this.inFlight += 1;
    try {
      const raw = await this.exchange(
        JSON.stringify({ requestId, operation: parsedOperation, params }),
      );
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch {
        throw new RunnerUnavailableError('runner returned malformed JSON');
      }
      const response = runnerResponseSchema.safeParse(parsedJson);
      if (!response.success) {
        throw new RunnerUnavailableError('runner response failed schema validation');
      }
      return response.data;
    } finally {
      this.inFlight -= 1;
    }
  }

  /** Cheap reachability probe used by the status dashboard. */
  async health(): Promise<{ ok: boolean; detail: string; latencyMs?: number }> {
    const started = Date.now();
    try {
      const response = await this.invoke('system.health');
      const latencyMs = Date.now() - started;
      return response.ok
        ? { ok: true, detail: 'Runner responded to system.health.', latencyMs }
        : { ok: false, detail: response.error?.message ?? 'Runner reported failure.', latencyMs };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : 'Runner probe failed.',
        latencyMs: Date.now() - started,
      };
    }
  }

  private exchange(payload: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let socket: Socket;
      try {
        socket = connect({ path: this.options.socketPath });
      } catch (error) {
        reject(new RunnerUnavailableError(error instanceof Error ? error.message : 'connect failed'));
        return;
      }

      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => reject(new RunnerUnavailableError(`timed out after ${this.options.timeoutMs} ms`)));
      }, this.options.timeoutMs);

      socket.setNoDelay(true);

      socket.on('connect', () => {
        socket.write(`${payload}\n`);
      });

      socket.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > this.maxResponseBytes) {
          finish(() => reject(new RunnerUnavailableError('response exceeded size limit')));
          return;
        }
        chunks.push(chunk);
        // The runner terminates its single response with a newline and closes;
        // resolving on the delimiter avoids waiting for a lingering FIN.
        const joined = Buffer.concat(chunks);
        const newlineIndex = joined.indexOf(0x0a);
        if (newlineIndex >= 0) {
          finish(() => resolve(joined.subarray(0, newlineIndex).toString('utf8')));
        }
      });

      socket.on('error', (error: NodeJS.ErrnoException) => {
        const detail =
          error.code === 'ENOENT'
            ? 'socket not present (is project-control-runner.service running?)'
            : error.code === 'EACCES'
              ? 'permission denied on socket (check project-control group membership)'
              : (error.message ?? 'socket error');
        finish(() => reject(new RunnerUnavailableError(detail)));
      });

      socket.on('end', () => {
        const joined = Buffer.concat(chunks);
        if (joined.length === 0) {
          finish(() => reject(new RunnerUnavailableError('runner closed the connection without replying')));
        } else {
          finish(() => resolve(joined.toString('utf8').replace(/\n$/, '')));
        }
      });
    });
  }
}
