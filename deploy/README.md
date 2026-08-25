# Running LifeOS Inbox on a server

`scripts/deploy-to-hermes.sh` installs the code and the Hermes skill. It does
**not** turn on sync — that is two systemd units, shipped here as templates.

Both assume the install lives at `/opt/lifeos-inbox` (`LIFEOS_HOME`) and runs as
an unprivileged `lifeos` user. Edit those two values in the units if your layout
differs; keep `WorkingDirectory` equal to `LIFEOS_HOME` (the `--env-file-if-exists=.env`
path and `.tokens.json` are both resolved relative to it).

| Unit | Role |
|---|---|
| `lifeos-poll.service` | always-on 5-min incremental Gmail sync (`poll`) |
| `lifeos-brief.service` | one-shot morning brief (`brief`) |
| `lifeos-brief.timer` | fires the brief at 07:00 **system-local** time |

The brief needs its own timer: `poll` only syncs, it never renders a brief.
`OnCalendar` follows the system timezone, so set it first —
`timedatectl set-timezone Asia/Kolkata` (or wherever the owner is).

## Install (as root, on the VPS)

```bash
cp deploy/systemd/lifeos-poll.service  /etc/systemd/system/
cp deploy/systemd/lifeos-brief.service /etc/systemd/system/
cp deploy/systemd/lifeos-brief.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now lifeos-poll.service
systemctl enable --now lifeos-brief.timer
systemctl start lifeos-brief.service     # optional: fire one brief now to validate
```

## Prerequisites (before enabling either unit)

Sync only works once the mailbox is linked and config is real:

1. `.tokens.json` present at `/opt/lifeos-inbox/.tokens.json`, mode `600` — minted
   by `npm run auth` **on a machine with a browser** (the consent flow binds
   `localhost:8787` and cannot complete headless), then `scp`'d over. Never commit it.
2. `.env` with `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Leave
   `ANTHROPIC_API_KEY` unset and `LIFEOS_MODEL_MODE=off` for rulepack-only
   operation (unclassified mail goes to `npm run review` instead of a model).
3. Real `owner.json` (card tails, name tokens) — the ownership guard fails closed
   without it, so the money view stays empty.

## Verify

```bash
systemctl status lifeos-poll.service
journalctl -u lifeos-poll.service -n 20 --no-pager   # expect "+N new" / "no change"
systemctl list-timers lifeos-brief.timer             # shows the next 07:00 fire
```

## Rollback (zero Gmail blast radius — the app holds read-only scopes)

```bash
systemctl disable --now lifeos-poll.service lifeos-brief.timer
rm /etc/systemd/system/lifeos-poll.service /etc/systemd/system/lifeos-brief.{service,timer}
systemctl daemon-reload
```
