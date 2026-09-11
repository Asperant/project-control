# Manual checkpoints

Exactly five steps need a human. Each one requires either a browser
consent flow or a secret that must not be machine-generated. Everything else is
automated.

Until all five are complete, **the deployment is not fully delivered**. `./pcctl status`
lists which remain.

---

## 1. Tailscale — login and HTTPS

**Why it cannot be automated:** device authorisation is a browser consent flow
against your tailnet, and MagicDNS/HTTPS are tenant settings in the admin
console.

```bash
# a. Install Tailscale, if it is not present
curl -fsSL https://tailscale.com/install.sh | sh

# b. Connect. This prints a URL — open it and approve the machine.
sudo tailscale up --ssh=false --accept-routes=false

# c. In https://login.tailscale.com/admin/dns enable:
#      * MagicDNS
#      * HTTPS Certificates

# d. Publish both services
sudo ./pcctl configure-tailscale
```

**Verify**

```bash
tailscale status                      # BackendState must be "Running"
tailscale serve status                # must show 8780 and 5678
./pcctl status                        # prints both URLs
curl -I https://<host>.<tailnet>.ts.net/     # from another tailnet device
```

Expected: `HTTP/2 200`. From a device **not** on the tailnet, the same URL must
fail to resolve or connect — that is the point.

> `configure-tailscale` uses `tailscale serve`, never `funnel`, and aborts if
> Funnel is enabled.

---

## 2. First administrator account

**Why it cannot be automated:** there is no default account and no environment
variable that creates one. A password supplied by a script would live in that
script.

```bash
sudo ./pcctl create-admin
```

Prompts for email, display name and password (minimum 12 characters, hashed with
Argon2id, not echoed, not written to shell history).

**Verify**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8780/api/auth/me
# 401 — anonymous access is refused
```

Then sign in at the portal URL. Re-running the command offers a password reset
and revokes all existing sessions for that account.

---

## 3. Google Drive OAuth + restic password

**Why it cannot be automated:** OAuth requires browser consent, and the restic
passphrase must be chosen and stored by you.

```bash
sudo apt-get install -y restic
curl -fsSL https://rclone.org/install.sh | sudo bash

sudo ./pcctl configure-google-drive
```

Name the rclone remote exactly **`gdrive`**. On a headless host, answer `n` to
"use web browser to automatically authenticate" and follow the printed
instructions.

> **The restic passphrase is unrecoverable.** Lose it and every existing
> snapshot is permanently undecryptable. Store it in a password manager or on
> paper — a copy that exists only on the machine being backed up is not a copy.

**Verify**

```bash
sudo ./pcctl backup
sudo ./pcctl restore-test
```

The restore test must report `PASSED`. A backup that has never been restored is
a hypothesis, not a backup.

---

## 4. Telegram bot token and chat id

**Why it cannot be automated:** the token comes from a conversation with
@BotFather.

```bash
sudo ./pcctl configure-telegram
```

1. In Telegram: message **@BotFather** → `/newbot` → follow the prompts.
2. Message your new bot once, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read
   `result[0].message.chat.id`.

The token is validated against `getMe` before it is stored, and a test message is
sent immediately.

**Verify** — the test notification arrives in your chat.

If you skip this, installation still succeeds; the component is reported as
`MANUAL_CONFIGURATION_REQUIRED` rather than failed.

---

## 5. n8n owner account

**Why it cannot be automated:** n8n's owner setup is a first-run UI flow. This
deployment deliberately does **not** use an undocumented API or write directly to
n8n's tables to bypass it — either would be an unsupported path that a future n8n
release could silently break.

1. Open `https://<host>.<tailnet>.ts.net:8443/`
2. Complete the owner setup form.

**Verify**

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5678/healthz   # 200

# Credentials must survive a container rebuild:
sudo ./pcctl restart
# sign in again — the account and any workflows are still there
```

Persistence comes from `DB_TYPE=postgresdb` plus a stable
`N8N_ENCRYPTION_KEY_FILE`; nothing is stored in the container layer.

---

## Checklist

| # | Checkpoint | Command | Done when |
| --- | --- | --- | --- |
| 1 | Tailscale | `sudo ./pcctl configure-tailscale` | `tailscale serve status` shows 8780 and 5678 |
| 2 | Administrator | `sudo ./pcctl create-admin` | you can sign in to the portal |
| 3 | Google Drive | `sudo ./pcctl configure-google-drive` | `./pcctl restore-test` passes |
| 4 | Telegram | `sudo ./pcctl configure-telegram` | test message received |
| 5 | n8n owner | browser, port 8443 | you can sign in to n8n |

Then:

```bash
./pcctl verify
./pcctl verify-security
```
