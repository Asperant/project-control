import { describe, expect, it } from 'vitest';
import {
  automationManifestSchema, settleWorkflowRunRequestSchema, whoamiResponseSchema,
  workflowDefinitionSchema, workflowRunSchema,
} from './index.js';

const runId = '00000000-0000-4000-8000-000000000001';
const now = '2026-08-16T10:00:00.000Z';

function scheduledWorkflow(overrides: Record<string, unknown> = {}) {
  return {
    key: 'system-health',
    name: 'System Health',
    description: 'Reads system status.',
    trigger: 'scheduled',
    schedule: '*/30 * * * *',
    scope: 'global',
    timeoutSeconds: 120,
    idempotencyWindow: 'hour',
    requiredScopes: ['automation:run', 'system:read'],
    notify: { info: false, warning: true, critical: true },
    ...overrides,
  };
}

describe('whoami response', () => {
  it('accepts a user principal', () => {
    expect(
      whoamiResponseSchema.safeParse({ kind: 'user', userId: runId, role: 'admin' }).success,
    ).toBe(true);
  });

  it('accepts a service principal', () => {
    expect(
      whoamiResponseSchema.safeParse({ kind: 'service', accountKey: 'n8n-automation', scopes: ['automation:run'] })
        .success,
    ).toBe(true);
  });

  it('rejects a user payload carrying service fields', () => {
    expect(
      whoamiResponseSchema.safeParse({ kind: 'user', userId: runId, role: 'admin', accountKey: 'x' }).success,
    ).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(whoamiResponseSchema.safeParse({ kind: 'robot' }).success).toBe(false);
  });
});

describe('workflow definition', () => {
  it('accepts a well-formed scheduled workflow', () => {
    expect(workflowDefinitionSchema.safeParse(scheduledWorkflow()).success).toBe(true);
  });

  it('requires schedule when trigger is scheduled', () => {
    const { schedule: _schedule, ...withoutSchedule } = scheduledWorkflow();
    expect(workflowDefinitionSchema.safeParse(withoutSchedule).success).toBe(false);
  });

  it('rejects schedule when trigger is manual', () => {
    expect(
      workflowDefinitionSchema.safeParse(scheduledWorkflow({ trigger: 'manual', scope: 'project' })).success,
    ).toBe(false);
  });

  it('accepts a well-formed manual workflow with no schedule', () => {
    const { schedule: _schedule, ...manual } = scheduledWorkflow({ trigger: 'manual', scope: 'project' });
    expect(workflowDefinitionSchema.safeParse(manual).success).toBe(true);
  });

  it('rejects an unknown required scope', () => {
    expect(
      workflowDefinitionSchema.safeParse(scheduledWorkflow({ requiredScopes: ['action:execute'] })).success,
    ).toBe(false);
  });

  it('rejects a key that is not kebab-case', () => {
    expect(workflowDefinitionSchema.safeParse(scheduledWorkflow({ key: 'System_Health!' })).success).toBe(false);
  });
});

describe('automation manifest', () => {
  it('accepts a manifest with distinct keys', () => {
    const manifest = {
      version: 1,
      workflows: [scheduledWorkflow(), scheduledWorkflow({ key: 'backup-health', name: 'Backup Health' })],
    };
    expect(automationManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('rejects a manifest with a duplicate workflow key', () => {
    const manifest = { version: 1, workflows: [scheduledWorkflow(), scheduledWorkflow()] };
    const result = automationManifestSchema.safeParse(manifest);
    expect(result.success).toBe(false);
  });

  it('rejects an empty workflow list', () => {
    expect(automationManifestSchema.safeParse({ version: 1, workflows: [] }).success).toBe(false);
  });

  it('rejects an unknown manifest version', () => {
    expect(automationManifestSchema.safeParse({ version: 2, workflows: [scheduledWorkflow()] }).success).toBe(false);
  });
});

describe('workflow run', () => {
  function run(overrides: Record<string, unknown> = {}) {
    return {
      id: runId,
      workflowKey: 'system-health',
      projectId: null,
      status: 'running',
      triggerKind: 'scheduled',
      triggeredByUserId: null,
      serviceTokenId: runId,
      externalRef: null,
      queuedAt: now,
      startedAt: now,
      settledAt: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it('accepts a running run', () => {
    expect(workflowRunSchema.safeParse(run()).success).toBe(true);
  });

  it('accepts a settled run with a result', () => {
    expect(
      workflowRunSchema.safeParse(
        run({
          status: 'completed',
          settledAt: now,
          result: { summary: 'ok', severity: 'info', linkedActionId: null, artifactId: null, reason: null },
        }),
      ).success,
    ).toBe(true);
  });

  it('rejects an unknown status', () => {
    expect(workflowRunSchema.safeParse(run({ status: 'bogus' })).success).toBe(false);
  });
});

describe('settle request', () => {
  it('accepts a minimal completed settle', () => {
    expect(
      settleWorkflowRunRequestSchema.safeParse({ status: 'completed', summary: 'ok', severity: 'info' }).success,
    ).toBe(true);
  });

  it('accepts an optional linkedActionId and artifactId', () => {
    expect(
      settleWorkflowRunRequestSchema.safeParse({
        status: 'completed', summary: 'ok', severity: 'info', linkedActionId: runId, artifactId: runId,
      }).success,
    ).toBe(true);
  });

  it('rejects an unknown status value', () => {
    expect(
      settleWorkflowRunRequestSchema.safeParse({ status: 'queued', summary: 'ok', severity: 'info' }).success,
    ).toBe(false);
  });
});
