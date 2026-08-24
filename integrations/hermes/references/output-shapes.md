# What each command prints

Real shapes, so the agent can parse or quote without re-running anything.

## `npm run money`

```
  ! Gamma Classic          ····9012   ₹9,876.54  21d overdue  savesage@1
  ! Acme Rewards           ····8801   ₹2,600.00  15d overdue  savesage@1
    Gamma Shop             ····1234   ₹3,210.99  in 6d        savesage@1
  ? Acme Neo Credit Card                      —  amount in PDF  hdfc-statement@1
                                     ₹18,412.30  outstanding

  AT RISK
  ! amazonaws.com      suspended

  CANARY
    ALERT savesage@1 has produced nothing
```

`!` overdue · `•` due soon · `?` a bill exists but the amount is unreadable
(usually a password-protected PDF) · `✓` marked paid.

A `CANARY` section with any ALERT means the total is **not** trustworthy — the
ledger may be blind rather than empty. Always report the two together.

## `npm run loops`

```
  13 tracked · 1 dead · 4 escalate · 0 nudge · 2 open

  ! support@example.com is a dead address. 7 emails went there and none
    arrived, 6 of them after the first rejection had already come back.

  dead_channel  support@example.com — mail there bounces, use another route (7 threads)
  escalate      vendor@example.com — 53d silent after 1 message, escalate
      <threadKey>   Subject line here

  YOU OWE A REPLY
    support@other.com     replied 59d ago
```

A **dead channel** outranks every timer: no amount of waiting fixes an address
that rejects mail. Recommend a different route, never a nudge.

## `npm run radar`

Buckets by how soon, not by category: `OVERDUE`, `TODAY`, `THIS WEEK`, `LATER`.
Rows are verb-first — `Pay:`, `Vote:`, `Decide:`, `Submit:`, `Attend:`.
Countdowns switch to hours inside three days.

A window shows both edges — `2026-08-27 (window opened 2026-08-25)`. The
**closing** date is the deadline; the opening one is not.

## `npm run metrics`

```
  Tier 0 resolved         72.0%  36/50, no model call
  Urgent recall          100.0%  8/8
  Correction rate (7d)     0.0%  too few classified items to judge yet
  Parser quarantine        0.0%  0 messages a parser could not read
  Last sync                 4m  healthy
```

`Correction rate` is the trust metric. Above 10% the pipeline is not
trustworthy; under 5% sustained is what earns silent auto-filing. `Urgent
recall` below 100% is the serious one — a missed urgent is the product-killing
error, so surface it rather than averaging it into an overall accuracy figure.

## `npm run status`

```
{ "email": "...", "lastSyncAt": "...", "lastSyncOk": true, "connected": true }
```

`connected: false` means no mailbox is linked. Every other command will be empty
and that emptiness is meaningless — say so instead of reporting all-clear.
