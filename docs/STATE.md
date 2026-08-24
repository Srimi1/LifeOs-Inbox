# Where this project actually stands

Last updated 2026-08-24. Read this first when picking the work back up.

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
3. **Then** the tool surface for an agent runtime, and a scheduler for the brief.

## Open questions for the owner

- What is "Hermes Agent"? The integration shape depends on whether it is a
  runtime you control, a hosted product, or a concept.
- Should this repo stay public? The rulepack still reveals which banks and
  services the mailbox uses — far lower stakes than card data, but a real signal.
