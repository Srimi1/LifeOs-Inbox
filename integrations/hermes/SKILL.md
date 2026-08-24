---
name: lifeos-inbox
description: "LifeOS Inbox: what do I owe, who owes me a reply, what closes soon."
version: 0.1.0
author: Srimi1
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [Email, Triage, Bills, Deadlines, Follow-up, Personal, Finance]
    homepage: https://github.com/Srimi1/LifeOs-Inbox
    related_skills: [himalaya]
prerequisites:
  commands: [node, npm]
  env: [LIFEOS_HOME]
---

# LifeOS Inbox

A triage engine over the owner's mailbox. It answers four questions and nothing
else: **what do I owe, who owes me a reply, what closes soon, and what needs me
today.**

It is not an email client and it does not send mail. Every command below is
read-only against a local store that a separate poller fills.

## When to use this

Reach for it whenever the owner asks about money owed, a bill, a subscription, a
deadline, a support ticket that has gone quiet, or "what do I need to deal with".
Also use it unprompted when composing a morning summary.

Do **not** use it to read or search mail generally — that is `himalaya`'s job.
LifeOS only knows about obligations it has already derived.

## Setup

`LIFEOS_HOME` must point at the checkout. All commands run from there.

```bash
export LIFEOS_HOME=/opt/lifeos-inbox     # or wherever it is installed
cd "$LIFEOS_HOME"
```

If `npm run status` reports `"connected": false`, the mailbox has never been
linked and every other command will return nothing. Say so plainly rather than
reporting an empty result as good news.

## Commands

| Command | Answers |
|---|---|
| `npm run money` | Bills and renewals owed, worst first, with a canary for missing bills |
| `npm run loops` | Open support threads, who is silent, dead email addresses |
| `npm run radar` | Every dated commitment in the next 30 days on one timeline |
| `npm run brief:dry` | The full morning brief, printed |
| `npm run review` | Signals the pipeline could not classify |
| `npm run metrics` | Whether the classifier can be trusted yet |
| `npm run card -- <category>` | Which card the owner's own rules pick for a category |
| `npm run status` | Sync health — run this first if anything looks empty |

Two commands change state, so only run them when the owner explicitly asks:

| Command | Effect |
|---|---|
| `npm run paid -- <obligationId>` | Marks a bill paid. Ids come from `npm run money`. |
| `npm run correct -- <signalId> <category> [urgency] [action]` | Teaches the classifier. The correction outranks every future run permanently. |

## How to report what it says

**Lead with what is overdue or at risk.** The output is already sorted worst
first — preserve that order, do not regroup it by category.

**Quote its figures exactly.** Every amount and date it prints is extracted from
a source email with verbatim evidence attached. Never round, restate from
memory, or compute a total yourself; if a number is not in the output, it is not
known.

**Never say a bill is paid.** LifeOS sees mail, not bank accounts. The honest
phrasing is "no payment confirmation reached the inbox", which is not the same
thing. The owner may well have paid through an app.

**Never offer to pay anything.** This is advise-only by design. Point at the
bank or the biller; do not propose a transaction.

**Surface the canary.** If `npm run money` prints a CANARY alert, say so in the
same breath as the total — an alarming canary means the total is not trustworthy,
and a blind ledger looks exactly like a month with no bills.

## Honest limitations — state these when relevant

- As of 2026-08-24 this has **never run on live mail**. If `npm run status` shows
  no connection, everything below is fixtures.
- Classification resolves roughly **72%** of real mail deterministically; the rest
  needs a model tier that has never been exercised. Do not quote 97.9% — that
  figure came from hand-picked test fixtures.
- Unknown senders fall through rather than being guessed at. An empty result
  means "not seen", never "nothing there".

See `references/output-shapes.md` for what each command prints.
