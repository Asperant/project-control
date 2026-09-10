import { readFileSync } from 'node:fs';
import { automationManifestSchema, type AutomationManifest, type WorkflowDefinition } from '@project-control/contracts';

/**
 * Loads and validates the workflow manifest.
 *
 * The manifest is a repository-owned file
 * (infra/n8n/workflows/manifest.json), read-only-mounted at deploy time —
 * never written by the Control API, never editable through a route, and
 * never a database table. This mirrors the runner's own compiled-in
 * operation registry: the set of workflows this platform can ever run is
 * fixed at deploy time, not a runtime-mutable list.
 *
 * Config rule 2 (see config.ts) applies here too: an invalid or missing
 * manifest must fail loudly at boot, not be tolerated and produce a partially
 * working automation surface later.
 */
export function loadManifest(path: string): AutomationManifest {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(`Unable to read the automation manifest at ${path}.`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`The automation manifest at ${path} is not valid JSON.`, { cause });
  }

  const result = automationManifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
    throw new Error(`The automation manifest at ${path} failed validation:\n${issues}`);
  }
  return result.data;
}

export function findWorkflow(manifest: AutomationManifest, key: string): WorkflowDefinition | undefined {
  return manifest.workflows.find((workflow) => workflow.key === key);
}
