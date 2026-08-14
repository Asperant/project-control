# Project registration

Register a project by pointing the panel at a folder that already exists on
this Ubuntu host — no browser file picker, no upload, no cloning. The panel
inspects the folder read-only, shows you exactly what it found, and creates
nothing until you confirm.

For the security design behind every claim in this document, see
[`security-model.md`](security-model.md#11-project-registration). For the API
surface, see [`architecture.md`](architecture.md#project-registration-surface).

---

## Usage flow

```
Projects → New project → type the full folder path → Inspect
  → review the detected information, edit anything, add rules
  → Save project
```

1. **Projects → New project.** The only required field is the project
   folder's full path, e.g.

   ```
   /home/asrin/Desktop/workspace/chicek-frontend-observability
   ```

   Type it exactly — the panel never browses the filesystem for you, and the
   path you type is what gets validated, not something inferred from a
   picker.

2. **Inspect.** The server resolves the path, confirms it is inside an
   allowed root (below), and reads:
   - git state, if the folder is a repository (branch, remote, last commit,
     dirty/untracked counts) — entirely from local refs and a read-only `git`
     invocation; nothing ever touches the network;
   - technology signals from a fixed set of known project-definition files
     (`package.json`, `go.mod`, `requirements.txt`, `Dockerfile`, …) — never
     from arbitrary source files, and never a secret-shaped file (`.env`,
     `id_rsa`, `credentials.json`, `*.pem`, …), which are structurally
     unreachable rather than filtered out.

   Nothing is written to your database at this point. The result is a
   short-lived (15 minute), single-use preview tied to your session.

3. **Review and edit.** Every detected field — name suggestion, technologies,
   commands, git summary — is editable before you save. Remove a
   wrongly-detected technology, add one the scanner missed, add project rules.

4. **Save project.** Only now does a row get written. The server
   re-validates the path and the inspection (ownership, expiry, single use)
   inside the same transaction that creates the project, so two browser tabs
   confirming the same inspection cannot both succeed.

---

## Allowed roots

The folder you register must be inside a **root-owned, deployment-level**
allowlist — `/srv/project-control/config/allowed-project-roots.conf` — that
neither the web panel nor the Control API can modify. The initial default is:

```
/home/asrin/Desktop
```

Adding a second root is a host-level change, not a panel setting:

```bash
sudo nano /srv/project-control/config/allowed-project-roots.conf   # add one absolute path per line
sudo ./pcctl install                                               # idempotent: regenerates the systemd
                                                                     # exception and restarts the runner
```

You do **not** need to grant permission per project — once a root is
configured, any folder under it (at any depth) can be registered without
further host-side steps.

The panel:

- never lists the contents of an allowed root;
- never offers a folder browser;
- only ever inspects the exact path you typed.

---

## What gets detected

| Category | Examples |
| --- | --- |
| Languages | JavaScript/TypeScript, Python, Go, Rust, Java/Kotlin, C#/.NET |
| Frameworks | React, Next.js, Vue, Express, Fastify, NestJS, Django, Flask, FastAPI |
| Package managers | pnpm, npm, Yarn, Bun, pip, Poetry, pipenv, uv, Cargo |
| Build tools | Vite, Webpack, esbuild, Rollup, Make, Maven, Gradle, .NET SDK |
| Test tools | Jest, Vitest, Mocha, Playwright, Cypress, pytest |
| Containers | Docker, Docker Compose |
| Databases | PostgreSQL, MySQL, MariaDB, MongoDB, Redis, SQLite (detected from dependency names and Compose service images) |
| Monorepo | npm/Yarn workspaces, pnpm workspaces |

Each detected technology keeps its evidence (the manifest file it was found
in) and a detection source of `manifest`; anything you add by hand is
recorded as `user`. A rescan only ever adds or removes `manifest`-sourced
rows — anything you added yourself is never touched.

Detected **commands** (test/lint/build/typecheck/validate) are recorded as
metadata only — the exact string found in a `package.json` script or
Makefile target. **This platform never executes them.** There is no button,
API route, or runner operation that runs a project command; command
management exists purely so this information lives alongside the project
instead of scattered across README files.

---

## Rescanning

A project's detail page has a **Rescan** action: it re-inspects the folder
and shows a diff against what's stored — nothing is written until you review
it and click apply.

| Change | Severity |
| --- | --- |
| Branch, default branch, last commit, working-tree dirty state changed | informational |
| A remote URL changed but the repository identity is the same | informational |
| A technology or command was newly detected or no longer found | informational |
| The folder is no longer accessible | warning |
| **The repository's identity changed** (the remote now points somewhere else) | **critical — requires an explicit separate confirmation** |

The critical case is deliberate: it usually means either the folder was
repurposed for a different repository, or something is wrong, and the panel
will not silently repoint a project's registered identity without you
checking a box that says so explicitly.

---

## Archiving

A project is never physically deleted. **Archive** hides it from the default
list view (toggle "Include archived" to see it) and blocks further edits
until it is **reactivated**. Reactivating re-checks the duplicate-path and
duplicate-repository rules — if another active project has since taken the
same folder or repository, reactivation is refused with a clear conflict
message rather than silently creating a collision.

---

## Troubleshooting

See [`troubleshooting.md`](troubleshooting.md#project-registration-issues).
