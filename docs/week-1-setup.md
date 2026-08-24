# Week 1 setup — the parts only you can do

Everything else in week 1 is built and passing. These three steps need your
hands on a browser, and the first one should happen **before** any more feature
code, because it is the single riskiest external dependency in the project.

---

## 1. Google OAuth — publish to Production, unverified (~20 minutes)

**Why this matters more than it looks.** An OAuth app left in *Testing* status
expires its refresh tokens every **7 days**. Your sync would silently die each
week, and a stale LifeOS that quietly stops seeing new mail is worse than no
LifeOS at all — it tells you there is nothing to do while a bill goes overdue.
Publishing to Production (without requesting verification) keeps the token
alive as long as the app is used at least once every six months.

You are the developer and the only user, so Google's personal-use exception
applies: you will see an "unverified app" warning once, click through it, and
never see it again.

1. Go to <https://console.cloud.google.com/> and create a project — call it
   `lifeos-inbox`.
2. **APIs & Services → Library** → enable **Gmail API**. (Do *not* enable
   Calendar. Your calendar is empty; the scope would be consent surface for
   nothing.)
3. **APIs & Services → OAuth consent screen**:
   - User type: **External**
   - App name `LifeOS Inbox`, your email as support + developer contact
   - Scopes: add **`.../auth/gmail.readonly`** only. Nothing else.
   - Add yourself as a test user.
4. **Publish the app.** On the OAuth consent screen, click **Publish app** →
   confirm. Status must read **In production**. Do **not** click "Prepare for
   verification".
5. **Credentials → Create credentials → OAuth client ID**:
   - Type: **Web application**
   - Authorised redirect URI: `http://localhost:8787/oauth/callback`
   - Copy the client ID and secret.
6. In the repo:
   ```bash
   cp .env.example .env      # paste the client ID and secret
   npm run auth              # opens the consent URL
   ```
   At the warning screen: **Advanced → Continue**.

**The check that this actually worked** is not that it connects today — it is
that it still works in eight days. Run `npm run status` next week. If it fails
with `invalid_grant`, the app slipped back to Testing and step 4 didn't take.

> If Google ever hard-blocks unverified restricted scopes, the fallback is
> already in the architecture: a Gmail filter that auto-forwards to an
> inbound-parse address needs no OAuth at all. That is a week of work, not a
> rewrite, because ingestion sits behind a connector interface.

---

## 2. The college-channel question (~5 minutes)

The plan cut Study Pressure Cockpit because a 365-day search of this mailbox
found exactly **one** real email from `sxcpatna.edu.in` — and it arrived as a
BCC. Before that stays cut, rule out the boring explanations:

- [ ] Search `srijansaanand0@gmail.com` for `.edu.in` / `.ac.in` mail. Anything?
- [ ] Does St. Xavier's issue a student webmail or an LMS that mails you?
- [ ] Did your July medical-leave email to `info@sxcpatna.edu.in` ever get a
      reply? A reply proves the channel works in both directions.

**If the channel is dead:** nothing changes. Deadline Radar already ships with
live data (card due dates, e-voting windows, cohort deadlines).

**If mail does exist somewhere:** set up server-side auto-forwarding to your
personal Gmail today and let it run as a passive experiment. Classification
keys on the *original* sender, so forwarded mail still routes correctly. If
real volume appears by week 5, `academic` gets promoted from a rule back to a
first-class category.

---

## 3. Turn on ₹0 transaction alerts (~10 minutes)

Credit Card Brain's same-day spend picture depends on issuers actually emailing
every transaction. Most default to a ₹5,000 threshold, which hides exactly the
small spend that adds up.

In each bank's net-banking alert settings, set the **email** alert threshold to
₹0 or ₹1:

- [ ] HDFC (Tata Neu Plus ····7895, Biz Grow ····5609)
- [ ] ICICI (Amazon Pay ····9005)
- [ ] Axis (Flipkart ····4242)
- [ ] The card ending ····6268 seen in your Razorpay receipts

Note the honest limit: **UPI from a bank account is SMS-only** and will not
appear. UPI on a *credit* card does arrive by email — that is already parsed.
Account-level UPI enters monthly via statement, or via the Android SMS
forwarder in v1.x.

---

## What's already done

| | |
|---|---|
| Closed 12-category taxonomy, urgency, action, confidence | `packages/core/src/taxonomy.ts` |
| Signal envelope + HTML/MIME normalisation | `packages/core/src/signal.ts` |
| Evidence-backed extractors (amount, date, card, ticket, VPA, DSN) | `packages/core/src/extract/` |
| Seed rulepack, 30 rules from real senders | `packages/core/src/rulepack/seed.ts` |
| Sender parsers: SaveSage, Razorpay, HDFC alert, HDFC statement | `packages/core/src/parsers/` |
| Ownership guard | `packages/core/src/ownership.ts` |
| Gmail OAuth + REST client + backfill + poller | `apps/worker/src/` |
| Postgres schema (JSONL store mirrors it for now) | `packages/core/src/db/schema.sql` |
| Acceptance eval on 115 real messages | `eval/run.ts` |

```bash
npm run eval       # 10 checks against your real mail
npm run typecheck
npm run auth       # after step 1
npm run backfill   # last 30 days
npm run triage     # what the pipeline makes of it
npm run poll       # every 5 minutes
```
