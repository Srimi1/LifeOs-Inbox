---
name: lifeos-inbox
description: "LifeOS Inbox: what do I owe, who owes me a reply, what closes soon."
version: 0.1.0
author: Srimi1
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [Email, Triage, Bills, Deadlines, Follow-up, Personal, Finance]
    homepage: https://github.com/Srimi1/LifeOs-Inbox
    related_skills: [himalaya]
---

# LifeOS Inbox (VPS / container edition)

A triage engine over the owner's mailbox. It answers four questions and nothing
else: **what do I owe, who owes me a reply, what closes soon, and what needs me
today.** It is not an email client and it does not send mail.

On this VPS, LifeOS runs as a **separate sidecar container** that syncs Gmail every
five minutes and writes its answers as plain-text files into this skill's `out/`
directory. **You do not run any command** — you read the files. They live beside
this file:

```
/opt/hermes/skills/lifeos-inbox/out/
  status.txt        sync health — READ THIS FIRST
  money.txt         bills and renewals owed, worst first, with the canary
  loops.txt         open support threads, who is silent, dead addresses
  radar.txt         every dated commitment in the next 30 days
  metrics.txt       whether the classifier can be trusted yet
  brief.txt         the full morning brief, rendered
  refreshed-at.txt  UTC timestamp of the last refresh (~5 min cadence)
```

## When to use this

Reach for it whenever the owner asks about money owed, a bill, a subscription, a
deadline, a support ticket that has gone quiet, or "what do I need to deal with".
Also use it unprompted when composing a morning summary. Do **not** use it to read
or search mail generally — that is `himalaya`'s job.

## How to answer

1. **Read `status.txt` first.** If it reports `"connected": false`, the mailbox has
   never been linked; every other file is empty. Say so plainly rather than
   reporting emptiness as good news.
2. Read the file for the question (`money.txt`, `loops.txt`, `radar.txt`, …) and
   report what it says. Mention `refreshed-at.txt` only if the owner needs to know
   how current it is (it refreshes about every five minutes).

## How to report what it says

**Lead with what is overdue or at risk.** The output is already sorted worst
first — preserve that order, do not regroup it by category.

**Quote its figures exactly.** Every amount and date is extracted from a source
email with verbatim evidence. Never round, restate from memory, or compute a total
yourself; if a number is not in the file, it is not known.

**Never say a bill is paid.** LifeOS sees mail, not bank accounts. The honest
phrasing is "no payment confirmation reached the inbox".

**Never offer to pay anything.** This is advise-only by design. Point at the bank
or the biller; do not propose a transaction.

**Surface the canary.** If `money.txt` prints a CANARY alert, say so in the same
breath as the total — an alarming canary means the total is not trustworthy, and a
blind ledger looks exactly like a month with no bills.

## State changes

Marking a bill paid or teaching the classifier a correction changes state and is
**not** exposed through these files. If the owner explicitly asks, tell them to run
it on the sidecar (`docker compose exec lifeos-inbox node apps/worker/src/index.ts
paid <id>` / `… correct <signalId> <category>`); do not attempt it yourself.

## Honest limitations — state these when relevant

- Classification resolves roughly **72%** of real mail deterministically; the model
  tier is **off** on this VPS, so the rest lands in a review queue rather than being
  guessed. Do not quote 97.9% — that came from hand-picked fixtures.
- Unknown senders fall through rather than being guessed at. An empty result means
  "not seen", never "nothing there".
