# LifeOS Inbox

<p align="center">
  <img src="assets/branding/logo.jpg" alt="LifeOS Inbox" width="160" style="border-radius: 28px;" />
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](tsconfig.json)
[![Runtime](https://img.shields.io/badge/Node-%E2%89%A522.18-339933.svg)](package.json)

**A skill an agent can call, not an app you open.**

LifeOS Inbox reads a mailbox and answers a small set of questions about it:
what do I owe, who owes me a reply, what closes soon, and what needs me today.
It is a typed capability surface plus a scheduler — the user interface is the
least important part of it, and mostly optional.

---

## What it actually is

The repo is roughly **5% presentation and 95% engine**. Every top-level export is
a pure function from a mail corpus to a typed answer:

```ts
triage(signal)                 // one message → category, urgency, action, evidence
classifySignal(signal)         // the above, escalating to a model only if needed
buildMoneyView(signals)        // bills, renewals, what is overdue, what is at risk
buildFollowUpView(signals)     // open loops, silence timers, dead channels
buildRadar(signals, obligs)    // every dated commitment on one timeline
buildBriefFacts(signals)       // the morning brief, as data
whichCard(category)            // "which card for dining?" — from your own rules
recordCorrection(signal, fix)  // teach it; the fix outranks the model permanently
computeMetrics(signals)        // can this be trusted yet
```

That shape is deliberate. An agent can call these; a cron can call these; a web
page can call these. Nothing in the core knows or cares which.

**Three things are not skill-shaped and need a service behind them:**

| | Why |
|---|---|
| **Push** | The 07:00 brief has to arrive whether or not you thought to ask. A capability that waits to be invoked is one you will never invoke. |
| **State** | Corrections, promoted rules, silence timers, the ledger overlay. A skill that forgets between calls cannot track a follow-up at all. |
| **Determinism** | Most classification is deliberately model-free so it answers the same way every run and corrections accumulate. Re-reasoning conversationally each time loses that. |

## How it works

```
Gmail ─┐
       ├─► intake ─► normalise ─► ① rulepack ─► ② model ─► decide ─► surfaces
capture┘             (Signal)      (free)      (fallback)          brief · ledger
                                                                    desk · radar
```

**Tier 0 — deterministic.** A rulepack of sender rules, per-issuer parsers and
regex extractors. Free, instant, and it gets *larger* over time: three consistent
corrections for a sender promote into a permanent rule, so the model's share
shrinks with use rather than growing.

**Tier 1/2 — the model, only for the residue.** Claude Haiku for what the rules
could not resolve, Sonnet for the ambiguous tail. Closed enums, structured
output, and every extracted value must quote verbatim evidence from the source
or it is discarded — which makes an invented due date structurally impossible
rather than merely unlikely.

**Redaction runs before anything leaves the machine.** Card numbers are masked
behind a Luhn check, account numbers become salted tokens, Aadhaar is matched on
its Verhoeff checksum, tax IDs are removed outright. A message containing a
one-time code is never transmitted at all.

### Modules

Modules read core signals and own their own state. Core never imports a module —
that direction is the whole extensibility seam.

- **Money Ledger** — obligations derived from signals, merged with lineage, plus
  a *canary* that alarms when a bill **source** goes silent. Absence detection:
  a ledger that has gone blind looks exactly like a month with no bills.
- **Follow-Up Desk** — entirely deterministic. Bounce aggregation, ticket IDs,
  silence timers, reply-close. No model is asked whether a message expects a reply.
- **Deadline Radar** — date-window extraction. A voting window closes on a date
  that is not the one it opens on; the closing edge is the deadline.

## Honest status

> Picking this up after a break? Start with [`docs/STATE.md`](docs/STATE.md).

**This has never run on live mail.** Not once. Every number below is measured
against a fixture corpus.

| | |
|---|---|
| Tier 0 on hand-picked fixtures | 97.9% |
| Tier 0 on an unbiased slice | **72.0%** |
| Both measured on | Gmail *snippets*, not message bodies |

The fixture corpus contains no message bodies — only ~125-character previews. So
the HTML/MIME layer has never been exercised, and both classes of bug found so
far were body-layer defects. Treat every accuracy figure here as provisional and
read [`docs/measured-accuracy.md`](docs/measured-accuracy.md) before quoting one.

The residue costs roughly **$1.25/month** through Haiku, against a planned ₹850
ceiling — so 72% is comfortable, not alarming. It is a floor: it rises as
corrections become rules.

`44 acceptance checks · 75 unit tests · typecheck clean`

## Running it

Zero runtime dependencies for the core — Node 22.18+ strips TypeScript natively,
so there is no build step.

```bash
npm ci
npm run typecheck && npm test

npm run auth        # one-time Google consent (see docs/week-1-setup.md)
npm run backfill    # last 30 days
npm run triage      # what the pipeline makes of it

npm run brief:dry   # the morning brief, printed
npm run money       # bills and renewals, worst first
npm run loops       # open loops and dead channels
npm run radar       # every dated commitment on one timeline
npm run metrics     # can this be trusted yet
npm run review      # what it could not resolve
npm run correct -- <id> bill today    # fix one; it outranks every future run
```

Personal configuration (`owner.json`, `cards.json`), ingested mail (`data/`),
credentials and recorded model responses are all gitignored and never leave the
machine. See `*.example.json` for the shapes.

## Using it from an agent

The capability surface is exposed to a **Hermes** agent — a local, skill-loading
agent — as a skill. `integrations/hermes/SKILL.md` teaches the agent when to reach for
LifeOS, which commands answer which question, and — importantly — how to report
the result honestly: quote its figures exactly, never claim a bill is paid
(LifeOS sees mail, not bank accounts), and always surface the canary alongside a
total, because a blind ledger looks exactly like a month with no bills.

```bash
./scripts/deploy-to-hermes.sh                   # local Hermes
./scripts/deploy-to-hermes.sh root@your.vps.ip  # over SSH
```

The script is idempotent, checks the Node version, never overwrites an existing
`owner.json`/`cards.json`, and never moves credentials.

## Design commitments

These are load-bearing, not preferences:

- **Read-only.** `gmail.readonly` and nothing else. All triage state lives in our
  own store. A triage layer that cannot hurt you is one you will let be wrong.
- **Advise, never execute.** Payments are deep links, never API calls. Drafts are
  never sent.
- **Corrections outrank models, permanently**, and are consulted before any call.
- **Urgency floors escalate and never demote.** A false urgent costs a glance; a
  missed urgent is how a triage product dies.
- **Nothing is dropped silently.** A parser that matches a money sender and reads
  nothing raises an alarm rather than filing it quietly.

## Licence

MIT.
