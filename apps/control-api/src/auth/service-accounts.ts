import type { ServiceScope } from '@project-control/contracts';

/**
 * Compiled-in service account registry.
 *
 * This is the machine-identity equivalent of the runner's compiled-in
 * operation table: the set of accounts that may ever hold a token is fixed at
 * build time, not editable through any route or database write outside this
 * file. `pcctl create-service-token <key>` refuses any key not listed here —
 * see cli/create-service-token.ts. Widening what a machine can reach is
 * always a code change and a redeploy, never a runtime action.
 *
 * Keep scopes minimal: an account should hold only what its current, actually
 * wired-up routes need. `action:plan`, `project:rescan` and `report:write`
 * are declared in the shared scope vocabulary (packages/contracts) but are
 * deliberately not yet granted to any account, because no route consumes them
 * yet.
 */
export type ServiceAccountDefinition = {
  key: string;
  displayName: string;
  scopes: readonly ServiceScope[];
};

export const SERVICE_ACCOUNT_REGISTRY: readonly ServiceAccountDefinition[] = [
  {
    key: 'n8n-automation',
    displayName: 'n8n automation engine',
    // `report:write` is granted because the shipped v1 manifest includes
    // weekly-project-report, which attaches a report artefact to its run.
    // `action:plan` and `project:rescan` remain reserved but ungranted — no
    // shipped workflow calls a route gated on either yet, and the routes
    // that would (the existing project rescan and Repository Action plan
    // endpoints) have not been retrofitted to accept a service principal at
    // all. See docs/automation.md for why project-validation is deferred.
    scopes: ['automation:run', 'project:read', 'system:read', 'report:write'],
  },
];

export function findServiceAccountDefinition(key: string): ServiceAccountDefinition | undefined {
  return SERVICE_ACCOUNT_REGISTRY.find((definition) => definition.key === key);
}
