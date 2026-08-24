# Where this project actually stands

Last updated 2026-08-24 (rev 2 — Hermes integration). Read this first when picking the work back up.

## The one-line summary

Six weeks of engine exist, they are tested, and **they have never once run on
live mail.** Nothing here is blocked on more code.

## What is built and green

| | |
|---|---|
| Deterministic triage spine, ~30 seed rules, sender parsers | done |
| Daily brief — facts/render split, no figure can be invented | done |
| Model tier — redaction, Haiku → Sonnet, evidence spans, cassettes | built, **never called** |
| Corrections → durable overrides → rule promotion | done |
| Money Ledger — obligations, merge lineage, source canary | done |
| Follow-Up Desk — bounces, ticket IDs, silence timers, reply-close | done |
| Deadline Radar — window extraction, one timeline | done |
| Trust metrics, quarantine queue, CI | done |

`44 acceptance checks · 75 unit tests · typecheck clean`

## What is NOT true, despite appearances

- **No live Gmail call has ever happened.** No OAuth, no backfill, no poller run.
- **No live model call has ever happened.** No `ANTHROPIC_API_KEY` is set. The
  whole Tier-1/2 path is theory: prompt quality, escalation thresholds, cost and
  latency estimates are all unvalidated.
- **The fixture corpus has no message bodies** — only ~125-char Gmail snippets.
  So `toPlainText` and the whole HTML/MIME layer are unexercised, and *both*
  classes of bug found so far were body-layer defects.
- **Accuracy: 72%, not 97.9%.** See `measured-accuracy.md`. The higher number was
  measured on hand-picked fixtures; the lower on an unbiased slice. Both used
  snippets, so treat both as provisional.

## The pattern worth remembering

Every serious bug was found by looking at **real mail**, never by reading code or
adding tests:

1. A parser silently dropped the largest bill in the mailbox on the day it was
   due, because one template omits the currency symbol.
2. Two entire cards were missing from the sample; one card was double-counted
   under two labels, inflating a total by more than double.
3. An external review found a ReDoS reachable from ordinary marketing mail, and a
   credential-blocklist gap that sent a live sign-in code to the model API.

The fixture corpus is the weak link. It is not a proxy for the mailbox.

## Hermes integration — done locally, not on the VPS

**Hermes is a Python agent at `~/.hermes/hermes-agent`.** It loads skills as
`SKILL.md` files with YAML frontmatter under `skills/<category>/<name>/`, with an
optional `references/` folder. It also ships `mcp_serve.py`, `tools/`, `plugins/`
and `optional-skills/` — the skill route was chosen as the smallest fit.

- **Installed:** `~/.hermes/hermes-agent/skills/productivity/lifeos-inbox/`
- **Vendored in this repo:** `integrations/hermes/` (source of truth — the copy
  in Hermes is installed from here, so edit this one)
- **Deploy script:** `scripts/deploy-to-hermes.sh [user@host]`

The skill is mostly *reporting discipline*, not command documentation: preserve
worst-first ordering, quote figures exactly, never claim a bill is paid, never
offer to pay, always surface the canary next to a total, and repeat the honest
limits when relevant.

**The VPS was not reached.** `194.164.151.25:22` times out from this machine —
wrong address, non-standard port, firewall, or a key that is not present. The
deploy script exists and is idempotent, but nobody has run it against the server.

Note for whoever does: `npm run auth` opens a browser and listens on
`localhost:8787`, so **OAuth cannot complete on a headless VPS.** Run it on a
machine with a browser, then `scp .tokens.json` across. Never into git.

## Decided

- **This is a skill, not an app.** ~5% of the repo is presentation. The
  capability surface (`buildMoneyView`, `buildRadar`, `whichCard`, …) is the
  product. Push, persistent state and determinism are the service behind it.
- **No PWA/native app for now.** Primary surface is push; a screen would be a
  thin drill-down at most. Design target if built: 390px, one thumb.
- **The repo is public.** Personal data must never enter tracked files or commit
  messages. `owner.json`, `cards.json`, `data/`, `eval/fixtures/inbox-sample.json`
  and `eval/cassettes/` are gitignored and must stay that way.

## Next, in order

1. **Live data.** Either the ~20-min Google OAuth setup (`week-1-setup.md`), or
   the auto-forward escape hatch (a Gmail filter to a dedicated address, three
   phone-minutes, no Cloud console). Until one exists, every number here is
   provisional and more features compound rework.
2. **Move the repo out of iCloud Drive.** `.git/index 2` already exists — iCloud
   has conflict-copied the git index once. `.tokens.json` would also sync Gmail
   credentials to Apple. `git clone` to `~/dev/lifeos-inbox`.
3. **Run `scripts/deploy-to-hermes.sh` against the VPS** once SSH works, then a
   scheduler (systemd or pm2 running `npm run poll`) so sync keeps going.

## Open questions for the owner

- **Working SSH details for the Hostinger VPS.** Port 22 on 194.164.151.25 times
  out; without a reachable host the deploy script cannot be run for you.
- Should this repo stay public? The rulepack still reveals which banks and
  services the mailbox uses — far lower stakes than card data, but a real signal.
