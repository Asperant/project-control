# Security policy

This project takes security seriously — see
[docs/security-model.md](docs/security-model.md) for the full threat model
and every control this platform claims, each traceable to a command you can
run (`./pcctl verify-security`), and
[docs/risk-registry.md](docs/risk-registry.md) for known, accepted risks and
their status.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for a security vulnerability.

Instead, use GitHub's private vulnerability reporting:
[Report a vulnerability](https://github.com/Asperant/project-control/security/advisories/new)
(Security tab → "Report a vulnerability"). If that isn't available to you,
open a normal issue asking to be contacted privately, with no technical
detail included, and a maintainer will follow up.

Please include:

- a clear description of the vulnerability and its impact;
- steps to reproduce it (a minimal example is ideal);
- the affected component (Control API, web panel, runner, automation, infra
  scripts) and, if known, the exact file/line.

## Scope

This is a self-hosted, single-tenant platform, reachable only over a
Tailscale tailnet by design — see
[docs/security-model.md § Threat model](docs/security-model.md#threat-model)
for what is explicitly in and out of scope (for example, a malicious
operator with root on the host is out of scope; a compromised container or
runner escaping its confinement is very much in scope).

## Response

There is no formal SLA — this is not a commercially supported product — but
reports are taken seriously and acknowledged as promptly as possible. A
confirmed vulnerability will be fixed and, where it affects a live
deployment, documented in [docs/risk-registry.md](docs/risk-registry.md)
either as mitigated or as an accepted, explained trade-off.
