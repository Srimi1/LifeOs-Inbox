# Integrating LifeOS Inbox into the Hostinger Hermes agent (Docker sidecar)

On this VPS, Hermes is a **Hostinger-managed Docker app** (`hermes-agent-ohnv`,
image `ghcr.io/hostinger/hvps-hermes-agent:latest`, behind `traefik`). Skills are
added by mounting a host directory into `/opt/hermes/skills/<name>`. LifeOS is a
Node/TypeScript app, not a single binary, so it runs as its **own sidecar
container** in the same compose project and shares a folder with Hermes:

```
LifeOS sidecar  ──writes──▶  data/skills/lifeos-inbox/out/*.txt  ◀──reads──  Hermes agent
(node:22, poll + brief)                                                     (SKILL.md)
```

No Docker socket, no HTTP server, no Node inside the Hermes image. The agent
answers from files the sidecar refreshes every ~5 minutes.

All host paths below are under the compose project dir **`/docker/hermes-agent-ohnv/`**
(so `./data` in the compose = `/docker/hermes-agent-ohnv/data`).

Legend: **[YOU]** a step only you can do · **[SECRET]** a credential I must never handle.

---

## 0. Prerequisites on your Mac (once) — see the main plan, Phase A

Mint the Gmail token where a browser exists; it cannot be done on the VPS.

- Clone out of iCloud to `~/dev/lifeos-inbox`, create the Google OAuth **Web**
  client (redirect `http://localhost:8787/oauth/callback`, consent = Production).
- `npm run auth` → produces `~/dev/lifeos-inbox/.tokens.json`. **[YOU][SECRET]**
- `npm run status` → `connected: true`.

You carry `.tokens.json` to the VPS in step 3.

---

## 1. Create the host directories

hPanel → **VPS → Terminal** (or `ssh root@194.164.151.25`), then:

```bash
cd /docker/hermes-agent-ohnv
mkdir -p data/lifeos/app
mkdir -p data/skills/lifeos-inbox/out
```

## 2. Clone LifeOS into the sidecar's app dir

```bash
git clone https://github.com/Srimi1/LifeOs-Inbox.git data/lifeos/app
```
(Public repo — no credentials. `git -C data/lifeos/app pull` to update later.)

## 3. Place config + the Gmail token (host side, never in git) **[YOU][SECRET]**

Create `data/lifeos/app/.env`:
```
GOOGLE_CLIENT_ID=…            # same client as your Mac
GOOGLE_CLIENT_SECRET=…
LIFEOS_MODEL_MODE=off         # rulepack-only; no model calls
# RESEND_API_KEY / BRIEF_TO   # optional: real 07:00 email; else brief lands in data/outbox/
```
Copy the token from your Mac (from `~/dev/lifeos-inbox`):
```bash
scp ./.tokens.json root@194.164.151.25:/docker/hermes-agent-ohnv/data/lifeos/app/.tokens.json
```
Fill real PII on the VPS (gitignored, so the clone did not bring them):
`data/lifeos/app/owner.json` (real `cardLast4`, `nameTokens`) and `cards.json`.
Then lock the secrets down:
```bash
cd /docker/hermes-agent-ohnv/data/lifeos/app
chmod 600 .env .tokens.json owner.json cards.json 2>/dev/null || true
```
Without a real `owner.json` the ownership guard fails closed and `money.txt` stays empty.

## 4. Install the skill files Hermes will read

```bash
cd /docker/hermes-agent-ohnv
cp data/lifeos/app/deploy/vps/SKILL.container.md   data/skills/lifeos-inbox/SKILL.md
cp -r data/lifeos/app/integrations/hermes/references data/skills/lifeos-inbox/references
```

## 5. Edit the compose (hPanel → Docker Manager → Manage `hermes-agent-ohnv` → .yaml editor)

Two edits — the exact YAML is in `deploy/vps/compose.lifeos-sidecar.yaml`:

1. Add one line to the **existing** `hermes-agent` `volumes:` list:
   ```yaml
   - ./data/skills/lifeos-inbox:/opt/hermes/skills/lifeos-inbox
   ```
2. Add the whole **`lifeos-inbox:`** service under `services:`.

Click **Deploy**. This recreates the app — **Hermes (and the Telegram bot) blinks
out for a few seconds**. Pick a quiet moment.

## 6. Verify

```bash
cd /docker/hermes-agent-ohnv
docker compose ps                              # lifeos-inbox = Up, hermes-agent = Up
docker compose logs -n 40 lifeos-inbox         # "installing…", then "starting Gmail poll loop"
cat data/skills/lifeos-inbox/out/status.txt    # connected: true  => token + .env landed
cat data/skills/lifeos-inbox/out/money.txt     # real bills (once owner.json is real)
```
Then ask Hermes *"what do I owe?"* — it should read `money.txt` and report worst-first,
canary included. First surface files appear within ~1 minute of the sidecar starting;
`out/refreshed-at.txt` shows the last refresh.

## Rollback (no Gmail blast radius — read-only scopes)

Remove the `lifeos-inbox:` service and the added volume line from the compose,
Deploy, then optionally `rm -rf /docker/hermes-agent-ohnv/data/lifeos` and
`data/skills/lifeos-inbox`. To fully revoke access, remove the app in your Google
account's security settings.

## Notes / failure modes

- **`status.txt` says connected:false** → `.tokens.json` missing/wrong path, or `.env`
  lacks the client id/secret. It must sit at `data/lifeos/app/.tokens.json`.
- **Token expired/revoked** → re-run `npm run auth` on the Mac, `scp` the fresh token.
  Set the Google app to **Production** so the refresh token does not expire weekly.
- **`money.txt` empty despite bills** → `owner.json` still placeholder; guard fails closed.
- **Brief hour** → fixed at 07:00 IST (01:30 UTC). Edit the minute check in
  `lifeos-entrypoint.sh` if the owner is in another timezone.
- **Model stays off** by design here. Unclassified mail shows in `metrics.txt` /
  the review queue, never guessed.
