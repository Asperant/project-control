import { readFile } from 'node:fs/promises';
import type { FastifyPluginAsync } from 'fastify';
import type {
  ComponentReport,
  ComponentStatus,
  SystemStatusResponse,
} from '@project-control/contracts';

import type { AppContext } from '../context.js';
import { createRequireAuth } from '../auth/middleware.js';

/**
 * `GET /api/system/status` — the dashboard payload.
 *
 * Every probe is wrapped so a failure becomes a component in the `down` state
 * rather than a 500: a status page that cannot render because one dependency is
 * unhealthy is exactly backwards.
 *
 * All probes run concurrently and each is individually time-boxed, so the
 * endpoint's latency is bounded by the slowest probe rather than their sum.
 */

const PROBE_TIMEOUT_MS = 4_000;

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(onTimeout());
      });
  });
}

const now = (): string => new Date().toISOString();

const report = (
  id: string,
  label: string,
  status: ComponentStatus,
  detail: string,
  latencyMs?: number,
): ComponentReport => ({
  id,
  label,
  status,
  detail,
  ...(latencyMs !== undefined ? { latencyMs } : {}),
  checkedAt: now(),
});

export const systemRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const requireAuth = createRequireAuth(ctx);

    app.get('/api/system/status', { preHandler: requireAuth }, async (request, reply) => {
      const [postgres, n8n, artifacts, runner, backup, tailscale] = await Promise.all([
        probePostgres(ctx),
        probeN8n(ctx),
        probeArtifacts(ctx),
        probeRunner(ctx),
        probeBackup(ctx),
        probeTailscale(ctx),
      ]);

      const components = [postgres, n8n, artifacts, runner, backup, tailscale];

      // Roll-up: any `down` makes the system down; anything not `ok` degrades it.
      // `manual_configuration_required` is treated as degraded, not down — the
      // platform works, a credential step is simply outstanding.
      const overall: SystemStatusResponse['overall'] = components.some((c) => c.status === 'down')
        ? 'down'
        : components.every((c) => c.status === 'ok')
          ? 'ok'
          : 'degraded';

      const body: SystemStatusResponse = {
        stackVersion: ctx.config.stackVersion,
        environment: ctx.config.env,
        generatedAt: now(),
        overall,
        components,
      };

      await ctx.audit.record({
        eventType: 'system.status.read',
        outcome: 'success',
        actorUserId: request.auth?.user.id ?? null,
        requestId: request.id,
        detail: { overall },
      });

      return reply.code(200).send(body);
    });
  };

// -----------------------------------------------------------------------------
// Probes
// -----------------------------------------------------------------------------

async function probePostgres(ctx: AppContext): Promise<ComponentReport> {
  return withTimeout(
    (async () => {
      const started = Date.now();
      const { rows } = await ctx.db.query<{ version: string; migrations: number }>(
        `SELECT current_setting('server_version') AS version,
                (SELECT count(*)::int FROM schema_migrations) AS migrations`,
      );
      const latency = Date.now() - started;
      const row = rows[0];
      return report(
        'postgres',
        'PostgreSQL',
        'ok',
        `Server ${row?.version ?? 'unknown'}, ${row?.migrations ?? 0} migration(s) applied.`,
        latency,
      );
    })(),
    PROBE_TIMEOUT_MS,
    () => report('postgres', 'PostgreSQL', 'down', 'Database did not respond in time.'),
  );
}

async function probeN8n(ctx: AppContext): Promise<ComponentReport> {
  return withTimeout(
    (async () => {
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS - 200);
      try {
        const response = await fetch(ctx.config.components.n8nHealthUrl, {
          signal: controller.signal,
          redirect: 'manual',
        });
        const latency = Date.now() - started;
        return response.ok
          ? report('n8n', 'n8n Automation', 'ok', `Health endpoint returned ${response.status}.`, latency)
          : report('n8n', 'n8n Automation', 'degraded', `Health endpoint returned ${response.status}.`, latency);
      } finally {
        clearTimeout(timer);
      }
    })(),
    PROBE_TIMEOUT_MS,
    () => report('n8n', 'n8n Automation', 'down', 'n8n health endpoint unreachable.'),
  );
}

async function probeArtifacts(ctx: AppContext): Promise<ComponentReport> {
  return withTimeout(
    (async () => {
      const started = Date.now();
      const health = await ctx.artifactStore.health();
      const { rows } = await ctx.db.query<{ live: number; bytes: number }>(
        `SELECT count(*)::int AS live,
                COALESCE(sum(size_bytes), 0)::bigint AS bytes
           FROM artifact_objects
          WHERE archived_at IS NULL`,
      );
      const latency = Date.now() - started;
      const live = rows[0]?.live ?? 0;
      const bytes = rows[0]?.bytes ?? 0;
      return health.ok
        ? report(
            'artifact_store',
            'Artifact Store',
            'ok',
            `${live} object(s), ${formatBytes(bytes)} tracked. ${health.detail}`,
            latency,
          )
        : report('artifact_store', 'Artifact Store', 'down', health.detail, latency);
    })(),
    PROBE_TIMEOUT_MS,
    () => report('artifact_store', 'Artifact Store', 'down', 'Artifact store probe timed out.'),
  );
}

async function probeRunner(ctx: AppContext): Promise<ComponentReport> {
  return withTimeout(
    (async () => {
      const health = await ctx.runner.health();
      return health.ok
        ? report('runner', 'Host Runner', 'ok', health.detail, health.latencyMs)
        : report('runner', 'Host Runner', 'down', health.detail, health.latencyMs);
    })(),
    PROBE_TIMEOUT_MS,
    () => report('runner', 'Host Runner', 'down', 'Runner probe timed out.'),
  );
}

/**
 * Backup status is read from a small JSON file that the backup systemd unit
 * writes after each run. The API deliberately does not shell out to restic:
 * that would need the repository password inside this container.
 */
async function probeBackup(ctx: AppContext): Promise<ComponentReport> {
  try {
    const raw = await readFile(ctx.config.components.backupStatusFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      configured?: boolean;
      lastRunAt?: string;
      lastResult?: string;
      lastCheckAt?: string;
      snapshotCount?: number;
    };

    if (parsed.configured === false) {
      return report(
        'backup',
        'Backup (Restic → Google Drive)',
        'manual_configuration_required',
        'Google Drive OAuth and the restic password have not been configured yet.',
      );
    }

    const ageHours = parsed.lastRunAt
      ? (Date.now() - new Date(parsed.lastRunAt).getTime()) / 3_600_000
      : Number.POSITIVE_INFINITY;

    if (parsed.lastResult !== 'success') {
      return report('backup', 'Backup (Restic → Google Drive)', 'down',
        `Last run reported "${parsed.lastResult ?? 'unknown'}".`);
    }
    if (ageHours > 36) {
      return report('backup', 'Backup (Restic → Google Drive)', 'degraded',
        `Last successful backup was ${Math.round(ageHours)} h ago.`);
    }
    return report('backup', 'Backup (Restic → Google Drive)', 'ok',
      `Last backup ${Math.round(ageHours)} h ago; ${parsed.snapshotCount ?? 0} snapshot(s).`);
  } catch {
    return report(
      'backup',
      'Backup (Restic → Google Drive)',
      'manual_configuration_required',
      'No backup status file yet. Run ./pcctl configure-google-drive, then ./pcctl backup.',
    );
  }
}

/**
 * Tailscale status is likewise read from a file written on the host by
 * `pcctl configure-tailscale`. The container has no tailnet access and no
 * tailscale binary, which is intentional.
 */
async function probeTailscale(ctx: AppContext): Promise<ComponentReport> {
  try {
    const raw = await readFile(ctx.config.components.tailscaleStatusFile, 'utf8');
    const parsed = JSON.parse(raw) as {
      configured?: boolean;
      backendState?: string;
      dnsName?: string;
      portalUrl?: string;
      n8nUrl?: string;
      httpsEnabled?: boolean;
    };

    if (parsed.configured === false || !parsed.dnsName) {
      return report('tailscale', 'Tailscale', 'manual_configuration_required',
        'Tailscale login and HTTPS enablement are still pending.');
    }
    if (parsed.backendState !== 'Running') {
      return report('tailscale', 'Tailscale', 'down',
        `Backend state is "${parsed.backendState ?? 'unknown'}".`);
    }
    if (parsed.httpsEnabled === false) {
      return report('tailscale', 'Tailscale', 'degraded',
        `Connected as ${parsed.dnsName}, but HTTPS certificates are not enabled for the tailnet.`);
    }
    return report('tailscale', 'Tailscale', 'ok',
      `Serving ${parsed.portalUrl ?? parsed.dnsName} and ${parsed.n8nUrl ?? 'n8n on :8443'}.`);
  } catch {
    return report('tailscale', 'Tailscale', 'manual_configuration_required',
      'No Tailscale status file yet. Run ./pcctl configure-tailscale.');
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
