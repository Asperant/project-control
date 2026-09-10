# Service accounts and tokens

## Principle

Every route this platform has ever exposed assumed a human behind it: a
session cookie, a CSRF token bound to that session, a role. That assumption
breaks the moment something like n8n needs to call the Control API on a
schedule — n8n has no browser, no cookie jar, and nothing to put in an
`Origin` header that would satisfy the existing check.

Service identity adds a second, narrower kind of caller rather than
stretching the first kind to fit. A **service token** authenticates over
`Authorization: Bearer pcs_...`, never a cookie, and is scoped to a small,
closed vocabulary of read/propose actions. It cannot execute a Repository
Action, apply a rescan diff, archive a project, or reach any route that has
not explicitly opted into accepting it. That last part is the load-bearing
design decision: **a route is closed to a service token unless its own code
says otherwise**, not because a check somewhere denies it, but because the
preHandler every existing route uses never reads the header a service token
would arrive in.

## Default posture: no machine caller exists

A fresh install has zero rows in `service_accounts` until the Control API's
first boot, which reconciles one row per entry in the compiled-in registry
(`apps/control-api/src/auth/service-accounts.ts`) — today, exactly one:
`n8n-automation`. It has zero rows in `service_tokens` until an operator runs
`sudo ./pcctl create-service-token n8n-automation`. Until that happens, no
Bearer header authenticates anything, anywhere, because there is no token row
for one to match.

Widening what a machine identity exists at all — adding a second account key,
widening an account's scope ceiling — is a code change to the registry file
and a redeploy. It is never a database write an operator can make through the
panel, and never a value `create-service-token` will accept for an unknown
key:

```
$ sudo ./pcctl create-service-token some-made-up-key
unknown service account key: some-made-up-key
known account keys: n8n-automation
```

## Scope

### Two kinds of principal, never one role system

`request.principal` is one of:

```
{ kind: 'user',    user, session }   — a session cookie resolved requireAuth's way
{ kind: 'service', account, token }  — a Bearer token resolved by ServiceTokenStore
```

A user principal's access is governed by `role` (`admin` / `operator` /
`viewer`), exactly as before this feature. A service principal's access is
governed by `scopes` on its token, which cannot exceed its account's scope
ceiling (enforced by a database trigger, not just application code — see
[Data model](#data-model)). The two systems are not merged: `requireRole`
denies any request without a resolved user, so a service token reaching a
role-gated route is rejected the same way an anonymous request is, and
`requireScope` is a deliberate no-op for a user principal, because a human's
access was never meant to be limited by the machine vocabulary.

### The scope vocabulary

| Scope | Reaches |
| --- | --- |
| `automation:run` | Claim/open/settle a workflow run (Stage 2 — not yet wired to a route) |
| `project:read` | Project, roadmap, memory, Work Session and Resume reads |
| `project:rescan` | Produce a rescan **diff preview** — never `rescan/apply` |
| `action:plan` | Produce a Repository Action **plan preview** — never `execute` |
| `system:read` | System status, verification report, backup status |
| `report:write` | Attach a report artefact to a workflow run (Stage 2) |

No member of this list applies a diff, executes a plan, archives a project,
or deletes anything. That is not an oversight to be filled in later — see
[What this feature deliberately does not do](#what-this-feature-deliberately-does-not-do).

### `n8n-automation`'s current scopes

The shipped registry entry grants `automation:run`, `project:read`,
`system:read` — the minimum a scheduled read-only report needs. `action:plan`,
`project:rescan` and `report:write` are declared in the vocabulary but not yet
granted to any account, because no route consumes them yet. Extending the
registry entry when that changes is a one-line code review, not a runtime
action.

## Minted like the first administrator, not like a session

`sudo ./pcctl create-service-token <account-key> [--ttl-days N]` is the only
way a token comes into existence — there is no HTTP route that creates one.
The reasoning is the same as `create-admin`'s: the plaintext exists exactly
once, and a browser response body is not a safe place for it to exist even
momentarily (response caching, dev-tools history, a screenshot). Unlike
`create-admin`, nothing here is typed by a human, so the command is
non-interactive and needs no TTY — it prints the token to stdout and nothing
else. It is never written to a file, a shell history entry, a log line, or
the audit trail, which records only the token's `prefix` (`pcs_` plus eight
characters, for identification, carrying no authenticating entropy) and its
scopes.

```
$ sudo ./pcctl create-service-token n8n-automation --ttl-days 365

Service token minted for 'n8n-automation'.
Scopes:  automation:run, project:read, system:read
Expires: 2027-08-17T09:00:00.000Z

pcs_AbCdEf...                                    ← shown once

Paste it into an n8n Header Auth credential:
  Header: Authorization
  Value:  Bearer <the value above>
```

A token has a mandatory `--ttl-days` (default 365, ceiling 365) — there is no
flag that means "forever". `sudo ./pcctl list-service-tokens` shows every
token's prefix, account, scopes, status and last-used time, never the value.
`sudo ./pcctl revoke-service-token <id>` (or the equivalent panel action,
admin-only) revokes it; revocation is one-way, enforced by the same database
trigger that makes a settled `project_actions`/`work_sessions` row immutable.

The panel's `Automation → Service tokens` view (admin role) offers the same
list and revoke — nothing else. There is no "create" button in the UI, for
the reason above.

## Closed by default, per route

`createRequireAuth` — the preHandler every route used before this feature —
is unchanged and still cookie-only: it never reads the `Authorization`
header. Every route that used it before this feature still uses it, so a
Bearer token presented to `/api/projects`, `/api/roadmap/...`,
`/api/projects/:id/actions/:actionId/execute`, or anything else outside
`/api/automation/*` is not rejected by a check that could be forgotten on a
new route — it is simply never looked at.

Only `createResolvePrincipal` reads `Authorization`, and only routes that
explicitly use it as their preHandler can ever be reached by a service token.
As of this feature, that is exactly `GET /api/automation/whoami` — a
diagnostic endpoint, reachable by both principal kinds, whose only purpose is
letting an operator confirm a freshly minted token actually authenticates:

```
$ curl -s -H "Authorization: Bearer pcs_..." \
    https://<host>.<tailnet>.ts.net/api/automation/whoami
{"kind":"service","accountKey":"n8n-automation","scopes":["automation:run","project:read","system:read"]}
```

A request carrying **both** a session cookie and a Bearer header is rejected
outright (`400 bad_request`, audited as `service.token_rejected` with
`reason: mixed_credentials`) rather than one being silently preferred — a
confused or compromised client must not be able to authenticate as a
different principal than the one it thinks it presented.

Two additional gates compose with `resolvePrincipal` for routes that accept
both kinds but must still restrict a specific action:

- **`requirePrincipalKind(ctx, 'user')`** — the mutation half of any future
  dual-principal route. A service principal reaching it is rejected
  (`403 forbidden`) and audited as `service.principal_kind_denied`.
- **`requireScope(ctx, ...scopes)`** — requires a service principal to carry
  every listed scope; a user principal always passes, since a human's access
  is `requireRole`'s job. A service principal missing a scope is rejected and
  audited as `service.scope_denied`.

**Why the ~40 pre-existing routes needed no change at all.** `requireRole`
reads `request.auth?.user.role`, and `resolvePrincipal` never sets
`request.auth` for a service principal — only `request.principal`. That means
`requireRole` already denies a service principal outright, for free, on any
route that carries it. Every existing mutation route (`execute`, `apply`,
`archive`, every admin-only route) is `requireRole`-gated already, so the day
one of them is ever switched from `requireAuth` to `resolvePrincipal` for
read access by both kinds, its *existing* role check keeps a service
principal out without a second gate needing to be added at the same time.
`requirePrincipalKind` exists for the narrower case a role check does not
cover: a route with no role restriction at all (any authenticated user may
read it) where one specific action must still stay human-only regardless of
role — `/api/automation/whoami` has no such case yet, but a future workflow
run's `cancel` action, reachable by any authenticated role, is the shape of
route that will need it.

## Data model

`migrations/0015_service_identity_schema.sql` /
`0016_service_identity_role_grants.sql`.

```
service_accounts
  id, key (unique, e.g. 'n8n-automation'), display_name
  scopes        TEXT[]   -- the ceiling; CHECK'd against the closed vocabulary
  status        'active' | 'disabled'

service_tokens
  id, account_id, token_hash (SHA-256, unique), prefix ('pcs_' + 8 chars)
  scopes        TEXT[]   -- CHECK'd against the vocabulary AND, by trigger,
                          -- against the owning account's scopes
  expires_at    NOT NULL -- no unexpiring token
  last_used_at, revoked_at, created_by, created_at
```

Two triggers do the enforcement a CHECK constraint cannot express on its own:

- **`guard_service_token_scopes`** (`BEFORE INSERT`) — rejects a token whose
  scopes are not a subset of its account's scopes. This is what makes
  `n8n-automation`'s three granted scopes a real ceiling rather than a
  convention: even an operator with the migrator credential, inserting a row
  by hand, cannot mint a wider token without first widening the account.
- **`guard_service_token_mutation`** (`BEFORE UPDATE`) — every identity field
  (`account_id`, `token_hash`, `prefix`, `scopes`, `expires_at`, `created_by`,
  `created_at`) is immutable from the moment the row exists; only
  `last_used_at` and `revoked_at` may change, and a revoked token can never be
  un-revoked. The same pattern `project_actions_guard_mutation` (0013) and
  `guard_work_session_mutation` (0011) use for their own terminal states.

Neither table is ever physically deleted from. `control_app` holds
`SELECT, INSERT, UPDATE` and explicitly not `DELETE`/`TRUNCATE` on both;
`backup_reader` holds `SELECT` only.

## Rate limiting

The global rate limiter keys a Bearer caller by a SHA-256 of its token rather
than by IP. This matters because n8n does not route through Caddy (it has its
own loopback port, fronted by its own Tailscale Serve entry) and the Control
API runs with `trustProxy: true` for the traffic that *does* come through
Caddy — an IP-keyed limiter would let a single machine caller influence its
own ceiling via a forged `X-Forwarded-For`. Keying by a hash of the token
instead ties the budget to the credential, not the network path, and never
holds the live token value in the limiter's in-memory store.

## Audit

`service.token_created`, `service.token_revoked`, `service.token_rejected`,
`service.scope_denied`, `service.principal_kind_denied`.

Detail: token id, prefix, account key, scopes, reason code. **The token value
never appears in an audit row, a log line, or an HTTP response — only its
prefix and its SHA-256.**

## Verification

| ID | Check |
| --- | --- |
| `SVC-001` | `service_tokens` has no plaintext-shaped column; `token_hash` is what is actually looked up by |
| `SVC-002` | Scope-ceiling and immutability triggers exist, are enabled, and guard with `RAISE EXCEPTION` |
| `SVC-003` | **Functional:** a cookie-only route returns the identical `401` to a Bearer header as to no credential at all |
| `SVC-006` | The scope vocabulary is closed by a database `CHECK` constraint, not only a TypeScript enum |
| `PGS-020` | `control_app` cannot `DELETE` from `service_tokens` |
| `PGS-021` | `backup_reader` cannot write to `service_accounts` |
| `SEC-006` | No secret file (including any future per-service distribution of one) ends in a whitespace byte — see the note below |

`SVC-004` (mixed cookie+Bearer rejection) and `SVC-005`
(revoked/expired/disabled-account rejection) are not re-proven by
`verify-security.sh`, which is strictly read-only and mints no token and logs
in as no one. Both are proven instead by
`apps/control-api/test/integration/service-tokens.test.ts` against a real,
disposable database — the same split `PGS-012`/`PGS-016`/`PGS-019` already
draw between trigger *existence* (verify-security) and trigger *behavior*
(integration tests).

**A note on `SEC-006` and this feature.** While building this feature, a
live-deployment check found the running stack's `n8n_encryption_key` and
`pg_n8n_app_password` secret files carry one trailing whitespace byte beyond
their intended length (n8n's own startup log already warns about this on
every restart). The code path that writes and distributes secrets
(`scripts/lib/common.sh:write_secret`, `scripts/generate-secrets.sh`) does not
add one and never has, going back to this repository's first commit — so this
is a stale, pre-existing artifact on this one deployment, not a defect this
feature introduced or inherited. `SEC-006` exists so a fresh install, and any
future secret this platform mints, cannot regress into the same state
silently. **Do not rotate `n8n_encryption_key` to clear an `SEC-006` failure
without reading its own warning first** — see
[security-model.md §6](security-model.md#6-secret-management): rotating it
orphans every credential n8n has ever encrypted.

## What this feature deliberately does not do

- No route that creates a `service_accounts` row — only the compiled-in
  registry, reconciled at boot and by `create-service-token`.
- No panel route that mints a token — only `pcctl`, at a host terminal.
- No unexpiring service token.
- No scope that can execute a Repository Action, apply a rescan diff, archive
  a project, or delete anything. `action:plan` and `project:rescan` reach only
  as far as a preview.
- No change to any existing route's authentication. Every route that used
  `createRequireAuth` before this feature still does, unchanged, and still
  cannot be reached by a Bearer token.
- No webhook, no inbound event trigger, no way for n8n to push a request the
  Control API did not ask to be pollable. (This feature adds no workflow
  runner or trigger surface at all yet — `automation:run` and `report:write`
  are reserved scopes for that later work, not wired to a route today.)
