# LifeOS Inbox

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6.svg)](tsconfig.json)
[![Runtime](https://img.shields.io/badge/Node-%E2%89%A522-339933.svg)](package.json)

A triage layer for life-admin mail. Every bill, renewal, support ticket, bounce
and promo that lands in the inbox is normalized into a **Signal**, classified
into a **closed taxonomy**, and stripped for **evidence-backed extractions** —
amounts, due dates, card tails, ticket IDs — each of which must be provable
against its source text or it does not exist.

Zero runtime dependencies. Pure TypeScript. Runs from source.

## Design principles

**Closed enums with honesty valves.**
Categories, urgencies and actions are closed vocabularies (`packages/core/src/taxonomy.ts`).
`other` and `needs_review` are always legal answers: a classifier forced to pick
a real value when unsure will confabulate.

**Evidence-backed extraction.**
Every extraction carries an `evidence` string and `offset`. The span is
re-checked verbatim against the source text before the extraction is allowed to
exist — a bad span is rejected as if the call had failed. This single rule kills
the entire "the model invented a due date" failure class, and lets a UI show the
exact source string behind every rupee and every date on screen.

**Enum confidence, not floats.**
There are no logprobs; false precision is worse than none. Confidence is
`high | medium | low`.

**Urgency only escalates.**
Urgency ranks are ordered weakest → strongest, so floors can merge but never
de-escalate. Anything ranked `today` or above is urgent.

**Ambiguity is surfaced, not guessed.**
Numeric dates are read DD-MM-YYYY (the Indian convention). A date where both
fields are ≤ 12 is genuinely ambiguous and is emitted with
`valueText: 'ambiguous_dmy'` so callers can require corroboration before
trusting it as a deadline.

**India-first, privacy-guarded.**
Amounts parse as they actually appear in Indian mail (`₹1,249`, `Rs. 361.00`,
`INR 1000`). Masked card tails (`XXXX 5609`, `····8842`) are extracted — but a
tail sitting near the word *Aadhaar* is a government identifier, never a card,
and is excluded before it can reach any model.

## Repository layout

| Path                | Purpose                                                        |
| ------------------- | -------------------------------------------------------------- |
| `packages/core`     | Taxonomy, Signal envelope, extractors (this is the engine)     |
| `apps/worker`       | Ingest worker — Gmail sync → Signal normalization *(planned)*  |
| `eval/fixtures`     | Real-world fixtures for extractor evaluation *(planned)*       |
| `docs`              | Architecture notes *(planned)*                                 |

### Core modules

| Module                        | Responsibility                                             |
| ----------------------------- | ---------------------------------------------------------- |
| `src/taxonomy.ts`             | Closed enums + urgency algebra                             |
| `src/signal.ts`               | The universal envelope; HTML-stripping; email normalization |
| `src/rulepack/`               | Priority rules + urgency floors; seed pack of real senders  |
| `src/parsers/registry.ts`     | Sender-specific bill parsers, with loud `quarantine` on template drift |
| `src/triage.ts`               | Tier-0 pipeline: rulepack → parser → extractors → ownership |
| `src/obligation.ts`           | Bills / renewals / deadlines as one deterministic model    |
| `src/ownership.ts`            | The not-yours guard for financial signals                  |
| `src/extract/date.ts`         | Due-date extraction, labelled-due resolution, day math     |
| `src/extract/amount.ts`       | INR amounts; total-due / min-due label detection           |
| `src/extract/identifiers.ts`  | Card tails, UPI VPAs, ticket IDs, dead addresses           |

## Configuration

The ownership guard needs to know who *you* are. Copy the example and fill it in —
`owner.json` is gitignored and must never be committed:

```bash
cp owner.example.json owner.json
```

With no `owner.json`, the guard fails closed: financial signals are flagged
`notYours` rather than silently trusted.

**Eval fixtures stay private too.** Real inbox samples contain personal mail,
so `eval/fixtures/*` is gitignored by default (see `example.sample.json` for
the schema). Keep real samples local; commit only synthetic data.

## Quickstart

Requires Node ≥ 22 (24+ recommended — runs TypeScript natively).

```bash
npm install
npm run typecheck
```

### Example: pull the bill out of a bill email

```ts
import { normalizeEmail } from './signal.ts';
import { extractDates, primaryDueDate, daysUntil } from './extract/date.ts';
import { extractAmounts, primaryAmount } from './extract/amount.ts';

const signal = normalizeEmail({
  id: '19a2…',
  sender: 'Card Services <noreply@bank.example>',
  subject: 'Your statement is ready',
  body: 'Total amount due Rs.361.00 · Payment due date 05-09-26',
  date: new Date().toISOString(),
});

const dates = extractDates(signal.text);
const amounts = extractAmounts(signal.text);

const due = primaryDueDate(signal.text, dates);   // labelled first, else earliest future
const total = primaryAmount(amounts);              // labelled total first, else largest

if (due?.valueDate && total?.valueNum !== undefined) {
  console.log(`₹${total.valueNum} due ${due.valueDate} (${daysUntil(due.valueDate)} days)`);
}
```

Every value above traces back to a highlighted substring in the original mail —
that is the evidence contract.

## Roadmap

- [x] Tier-0 rulepack classification (`skipLlm` fast path)
- [ ] LLM tier constrained to the closed taxonomy, with `needs_review` fallback
- [x] Ownership guard for financial signals (`notYours`)
- [ ] Gmail ingest worker → Signal pipeline
- [ ] Extractor eval harness over real fixtures
- [ ] Follow-Up Desk: thread-close detection from sent-mail seeding

## License

[MIT](LICENSE) © SrIjan_Saanand
