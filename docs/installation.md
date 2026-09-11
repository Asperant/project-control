# Installation

Clean install on a fresh Ubuntu 22.04 LTS (x86_64) machine.

## Prerequisites

| Requirement | Minimum |
| --- | --- |
| OS | Ubuntu 22.04 LTS, x86_64 |
| RAM | 4 GiB (8 GiB comfortable) |
| Disk | 20 GiB free on `/srv` |
| Privileges | root via sudo |
| Network | outbound HTTPS (Docker Hub, npm, Tailscale, Google Drive) |

The stack coexists with existing Docker projects. Installation never removes or
modifies a container, image, volume or network it did not create.

---

## 1. Base packages

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git jq python3
```

### Docker Engine + Compose v2

Skip if already installed — this deployment never reinstalls or reconfigures the
Docker daemon.

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg

echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io \
                        docker-buildx-plugin docker-compose-plugin

sudo usermod -aG docker "$USER"     # log out and back in
docker compose version
```

### Node.js 24 + pnpm (local development and tests only)

The privileged installer does not execute host Node or pnpm. Application images
use the digest-pinned Node build image and pinned pnpm inside Docker, so
`sudo ./pcctl install` does not need an nvm directory in root's `PATH`.

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo corepack enable
corepack prepare pnpm@11.15.0 --activate
```

### Go 1.26.5 (to build the runner)

```bash
curl -fsSLO https://go.dev/dl/go1.26.5.linux-amd64.tar.gz
echo "5c2c3b16caefa1d968a94c1daca04a7ca301a496d9b086e17ad77bb81393f053  go1.26.5.linux-amd64.tar.gz" \
  | sha256sum -c -
sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.26.5.linux-amd64.tar.gz
export PATH=$PATH:/usr/local/go/bin
echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.profile
go version
```

### Tailscale (required)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
```

### Backup tooling

Installed from pinned upstream releases with checksum verification, **not** from
the Ubuntu archive: jammy ships restic 0.12.1 (2021), four years behind. For the
component whose entire job is being correct about your last-resort copy of the
data, that is the wrong trade. Versions and checksums are in
`infra/versions.lock.env`.

```bash
# restic 0.19.1
curl -fsSLO https://github.com/restic/restic/releases/download/v0.19.1/restic_0.19.1_linux_amd64.bz2
echo "f415415624dcc452f2a02b8c33641791a8c6d6d3b65bbb3543fcf9a25151585c  restic_0.19.1_linux_amd64.bz2" | sha256sum -c -
bunzip2 restic_0.19.1_linux_amd64.bz2
sudo install -m 0755 restic_0.19.1_linux_amd64 /usr/local/bin/restic
restic version

# rclone 1.75.0
curl -fsSLO https://github.com/rclone/rclone/releases/download/v1.75.0/rclone-v1.75.0-linux-amd64.zip
echo "aa2804e08f48250e71009c727124b6341cd0288465804a9a09d14663cabafbaa  rclone-v1.75.0-linux-amd64.zip" | sha256sum -c -
unzip -q rclone-v1.75.0-linux-amd64.zip
sudo install -m 0755 rclone-v1.75.0-linux-amd64/rclone /usr/local/bin/rclone
rclone version
```

---

## 2. Get the repository

```bash
git clone <your-repository-url> project-memory-control-center
cd project-memory-control-center
chmod +x pcctl
```

---

## 3. Preflight

```bash
./pcctl preflight
```

Read-only. Writes `reports/preflight-report.md`. It must report **READY** before
you continue.

A port conflict on 443, 8443, 5678 or 8780 is reported as a failure and is
**never** worked around by choosing a different port — a silently relocated
portal is worse than a failed install. Free the port, then re-run.

---

## 4. Install

```bash
sudo ./pcctl install
```

This will:

1. re-run preflight and refuse to proceed on failure;
2. create the `project-control` group and the `project-runner` system user
   (no shell, no home, no sudo);
3. create `/srv/project-control` with the documented ownership and modes;
4. generate every secret from `/dev/urandom` into `0700` root-owned files;
5. install compose, Caddy, PostgreSQL init and migration files;
6. build the runner binary and both container images from digest-pinned bases;
7. install and enable the systemd units and backup timers;
8. start the stack and wait for every healthcheck;
9. run `verify`.

Expected tail:

```
[  OK ] all containers are healthy
  REMAINING MANUAL CHECKPOINTS …
```

---

## 5. Manual checkpoints

See [manual-checkpoints.md](manual-checkpoints.md). In order:

```bash
sudo ./pcctl configure-tailscale
sudo ./pcctl create-admin
sudo ./pcctl configure-google-drive
sudo ./pcctl configure-telegram
# then create the n8n owner account at https://<host>.<tailnet>.ts.net:8443/
```

---

## 6. Verify

```bash
./pcctl verify
./pcctl verify-security
sudo ./pcctl backup
sudo ./pcctl restore-test
```

All four must pass. `verify --json` and `verify-security --json` emit
machine-readable output for monitoring.

---

## 7. Reboot test

```bash
sudo reboot
# after it returns:
./pcctl status
./pcctl health
```

Both the runner and the stack must come back automatically —
`project-control-runner.service` and `project-control-stack.service` are enabled
at install time.

---

## Directory layout created

```
/srv/project-control/
  compose/          compose.yaml                            0755 root
  config/           stack.env, runner.env, caddy/, status/  0755 root
  secrets/          all secret material                     0700 root
  data/postgres/    database cluster                        0700 999:999
  data/n8n/         workflows, credentials                  0700 1000:1000
  data/artifacts/   objects/, temporary/                    0750 10001:10001
  backups/          staging/, restore-tests/, logs/         0750 root
  logs/             caddy access and error logs             0755 root
  runner/bin/       project-control-runner                  0750 project-runner
  migrations/       SQL migrations                          0755 root
  docs/             copy of this documentation              0755 root
```

---

## Uninstall

```bash
sudo ./pcctl uninstall                  # stops everything; KEEPS all data
sudo ./pcctl uninstall --delete-data    # destroys data; three confirmations
```

The default is non-destructive and a reinstall over it restores service.
