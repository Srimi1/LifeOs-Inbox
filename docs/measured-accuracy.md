# What the accuracy numbers actually mean

Measured 2026-08-24. Read this before quoting any percentage from this repo.

## Two very different numbers

| Corpus | Tier-0 resolved |
|---|---|
| `eval/fixtures/inbox-sample.json` — 145 hand-picked messages | **97.9%** |
| An unbiased 4-day slice — 50 threads, no sender filter | **72.0%** |

Both are real measurements of the same rulepack. The gap is entirely selection
bias: the fixture corpus was assembled by searching for senders already known to
matter, which is a near-perfect way to measure how well the rules cover the rules.

**72% is the number to plan against.** 97.9% is the number to distrust.

## What the misses look like

All fourteen were senders the pack had never seen, and thirteen were plainly
promotional: pointsyeah, ASUS, EaseMyTrip, TopCashback, beehiiv, Jaipur Watches,
Coursera, BigBasket, NVIDIA, Adobe, Facebook, a cold outreach, and — the
instructive one — `shop@fashioncollections.tatacliq.com`, where the pack already
covers `fashionnotification.tatacliq.com`. Same brand, different subdomain, missed.

There is no clever fix for this. New senders arrive forever; a rulepack converges
on the senders you have seen, never on the ones you have not.

## Why this does not break the design

The residue is exactly what the model tier is for. At ~45 messages a day, a 72%
Tier-0 rate leaves ~13 messages a day for Haiku 4.5:

| | |
|---|---|
| Haiku, ~13 msgs/day, prompt-cached | ~$0.74/month |
| Sonnet escalations, ~10% of residue | ~$0.51/month |
| **Total** | **~$1.25/month (₹110)** |

Against a planned ceiling of ₹850/month. The architecture holds comfortably; only
the headline number was inflated.

And the rate should climb on its own: every correction that promotes to a rule
removes a sender from the model's share permanently. 72% is a floor, not a ceiling.

## The caveat on this measurement too

The unbiased slice used search snippets rather than full message bodies, so the
`promo.unsubscribable` fallback could not fire the way it would on real ingest.
That rule labels but deliberately does not resolve, so it would not move the
Tier-0 figure much — but this is an estimate from a 50-message window, not a
census. A real 30-day backfill remains the only way to know.
