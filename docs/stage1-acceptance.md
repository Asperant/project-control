# Stage 1 acceptance criteria

Each criterion below states how it is proven, not merely that it was intended.
Run the commands yourself.

**Stage 1 is complete only when every row is `PASS`.** Rows depending on a manual
checkpoint cannot pass until that checkpoint is done — those are listed
separately at the end rather than being quietly counted as successes.

---

## Automated criteria

### 1. The portal is reachable only over Tailscale HTTPS

```bash
tailscale serve status                          # 443 → 127.0.0.1:8780
docker inspect project-control-caddy \
  --format '{{json .NetworkSettings.Ports}}'    # 127.0.0.1 only
```

*Checks:* `TS-002`, `NET-002`, `NET-003`. **Requires checkpoint 1.**

### 2. n8n is reachable only over Tailscale HTTPS :8443

```bash
tailscale serve status                          # 8443 → 127.0.0.1:5678
```

n8n is not routed through Caddy, so a proxy misconfiguration cannot expose it.

*Checks:* `TS-003`, `NET-002`. **Requires checkpoint 1.**

### 3. No management interface on the public internet

- No `ports:` entry binds anything but `127.0.0.1`.
- Funnel is never used and is actively checked for.
- No router or firewall change is required or made.

*Checks:* `NET-001`–`NET-003`, `TS-004`, `FW-002`.

### 4. PostgreSQL, Control API, Web and Runner publish no port

```bash
ss -tlnp | grep -E ':(5432|8080|8081)'     # no output
```

*Checks:* `NET-001`, `NET-004`, `NET-005`, `NET-006`.

### 5. PostgreSQL roles are isolated

Six connect/deny combinations plus append-only audit enforcement, asserted
against the live cluster.

```bash
./pcctl verify-security | grep PGS-
```

*Checks:* `PGS-001`–`PGS-006`. Also covered by the integration suite.

### 6. n8n uses PostgreSQL and its data persists

```bash
test ! -f /srv/project-control/data/n8n/database.sqlite && echo "not sqlite"
sudo ./pcctl restart
# workflows and credentials are still present
```

*Checks:* `N8N-001`–`N8N-004`.

### 7. Artifact upload/download and hash verification succeed

Run the self-test from the dashboard, or:

```bash
./pcctl verify | grep ART-
```

The endpoint exercises store → digest → atomic publish → read back → verify →
deduplicate → reject traversal → enforce size limit → record metadata.

*Checks:* `ART-001`–`ART-004`; 39 storage unit tests; 5 integration tests.

### 8. The runner rejects raw shell commands

`verify-security` sends three hostile payloads over the live socket and requires
all three to be refused.

```bash
./pcctl verify-security | grep RNR-007
```

*Checks:* `RNR-007`; Go tests `TestRejectsShellCommandShapedRequests` (19
payloads) and `TestRejectsCommandCarryingFields` (7 payloads).

### 9. Recreating a container does not lose data

```bash
sudo ./pcctl stop && sudo ./pcctl start
./pcctl verify
```

All state is bind-mounted under `/srv/project-control`; there is no state in any
container layer.

### 10. Services recover after a reboot

```bash
sudo reboot
# then:
systemctl is-enabled project-control-runner project-control-stack
./pcctl status
```

### 11. Secret scan and file permissions pass

```bash
./pcctl verify-security | grep -E 'SEC-|GIT-'
```

*Checks:* `SEC-001`–`SEC-005`, `GIT-001`–`GIT-004`.

### 12. `./pcctl verify` and `./pcctl verify-security` pass

Both must exit `0`.

### 13. Existing Docker projects are unaffected

```bash
docker ps -a --format '{{.Names}}\t{{.Status}}'
docker volume ls
```

Compare against `reports/stage1-preflight.md`, which inventories everything that
existed before installation.

*Checks:* `COE-001`, `COE-002`.

---

## Criteria requiring a manual checkpoint

| # | Criterion | Blocked by | Proven by |
| --- | --- | --- | --- |
| 14 | Telegram test notification arrives | checkpoint 4 | `sudo ./pcctl configure-telegram` |
| 15 | Encrypted backup to Google Drive + isolated restore test | checkpoint 3 | `sudo ./pcctl backup && sudo ./pcctl restore-test` |
| 16 | Update and rollback tested | requires a second version | `sudo ./pcctl update`, then `sudo ./pcctl rollback` |

---

## Test inventory

| Suite | Count | Command |
| --- | --- | --- |
| Contracts (schema validation) | 27 | `pnpm --filter @project-control/contracts test` |
| Control API unit | 102 | `pnpm --filter @project-control/control-api test:unit` |
| Control API integration (real PostgreSQL) | 64 | `pnpm --filter @project-control/control-api test:integration` |
| Web client | 30 | `pnpm --filter @project-control/web test` |
| Go runner (race detector) | 81 | `cd apps/runner && go test -race ./...` |
| `verify` | ~60 checks | `./pcctl verify` |
| `verify-security` | ~70 checks | `./pcctl verify-security` |

Counts above include the project registration feature (folder inspection,
technology/git detection, allowed-roots enforcement, inspection lifecycle).

### What the security-relevant tests actually assert

**Artifact store (39 tests)** — content addressing, byte-exact round trip,
sharding, deduplication, atomicity under mid-stream failure, digest mismatch
cleanup, size limits (including the store-wide ceiling overriding a caller),
zero-byte payloads, 12 path-traversal payloads rejected at both the resolver and
the read path, symlink rejection, staging sweep, health reporting.

**Auth (30 tests)** — Argon2id parameters and PHC output, unique salts, corrupt
hash handling, the dummy verifier used for unknown accounts, password policy,
token entropy and uniqueness, constant-time comparison across differing lengths,
CSRF accept/reject including cross-session tokens and oversized values, Origin
enforcement.

**Integration (44 tests)** — cookie attributes as actually emitted by Fastify,
account-enumeration parity between wrong-password and unknown-user, audit rows
written for success and failure, password absent from every response and audit
row, session rejection after logout / deactivation / absolute expiry / idle
expiry, CSRF rejection paths, per-IP rate limiting, real grant enforcement
(`UPDATE`/`DELETE` on `audit_events`, DDL, `DROP TABLE`), cross-database connect
refusal, artifact round trip, status payload containing no credential.

**Runner (20 tests)** — socket mode `0660` with no `other` bits, refusal to start
without a controlling group, refusal to clobber a non-socket file, 19 shell-shaped
operation names rejected, 7 command-carrying request shapes rejected, unknown
parameters rejected, exact-match-only lookup, timeout enforcement, concurrency
limit, panic containment (the server survives and keeps serving), output
redaction and truncation.

---

## Known limitations

1. **Rate limiting is per-process and in-memory.** Correct for a single API
   replica; a second replica would need shared state.
2. **`--read-data-subset=5%`** in the weekly check verifies a sample, not the
   whole repository. A full `restic check --read-data` is expensive at scale;
   run one manually after any storage incident.
3. **Rollback does not revert migrations.** Deliberate — see
   [update-rollback.md](update-rollback.md).
4. **No secondary backup destination.** Google Drive is a single off-site target.
5. **The runner exposes only read-only operations** (health/selftest plus
   project path validation, inspection, and git summary). Executing a
   project's own test/build/lint commands is explicitly out of scope — command
   definitions are stored as inert metadata only.
