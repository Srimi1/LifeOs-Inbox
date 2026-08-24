import type { TriageResult } from '../../core/src/triage.ts';
import type { ObligationDraft, ServiceStatus } from '../../core/src/obligation.ts';
import { normaliseCounterparty } from '../../core/src/obligation.ts';
import { datedCandidates } from '../../core/src/radar/windows.ts';

/**
 * Subscriptions, inferred from what actually got charged.
 *
 * A merchant that takes the same amount on a regular cadence is a
 * subscription whether or not it ever calls itself one — so the ledger can
 * know about a recurring charge before any renewal notice arrives.
 *
 * The discipline here is entirely in the negative cases. This mailbox contains
 * repeated Razorpay charges to one gift-card merchant — ₹975, ₹488.75, ₹300,
 * ₹150, ₹150, several on the same day — which a naive "same merchant more than
 * twice" rule would confidently report as a monthly subscription. It is not one.
 * Both regular *spacing* and stable *amount* are required, and a wrong
 * inference here would put a fictional bill in front of him.
 */
export interface Charge {
  merchant: string;
  merchantKey: string;
  amount: number;
  at: string;
  signalId: string;
}

export interface RecurringInference {
  merchantKey: string;
  label: string;
  amount: number;
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'annual';
  cadenceDays: number;
  charges: number;
  lastChargedAt: string;
  nextExpected: string;
  signalIds: string[];
}

const CADENCES: { name: RecurringInference['cadence']; days: number; tolerance: number }[] = [
  { name: 'weekly', days: 7, tolerance: 2 },
  { name: 'monthly', days: 30, tolerance: 6 },
  { name: 'quarterly', days: 91, tolerance: 12 },
  { name: 'annual', days: 365, tolerance: 25 },
];

/** At least this many charges before a pattern is a pattern. */
const MIN_CHARGES = 3;
/** Amounts must be this stable. A subscription bills the same number. */
const MAX_AMOUNT_SPREAD = 1.1;

export function chargesFrom(results: TriageResult[]): Charge[] {
  const out: Charge[] = [];
  for (const r of results) {
    if (r.classification.category !== 'transaction') continue;
    const merchant = r.extractions.find((e) => e.kind === 'merchant')?.valueText;
    const amount = r.extractions.find((e) => e.kind === 'amount' && typeof e.valueNum === 'number')?.valueNum;
    if (!merchant || typeof amount !== 'number' || amount <= 0) continue;
    out.push({
      merchant,
      merchantKey: normaliseCounterparty(merchant),
      amount,
      at: r.signal.occurredAt,
      signalId: r.signal.externalId,
    });
  }
  return out;
}

export function inferRecurring(charges: Charge[], now = new Date()): RecurringInference[] {
  const byMerchant = new Map<string, Charge[]>();
  for (const c of charges) {
    const list = byMerchant.get(c.merchantKey);
    if (list) list.push(c);
    else byMerchant.set(c.merchantKey, [c]);
  }

  const inferences: RecurringInference[] = [];

  for (const [key, list] of byMerchant) {
    if (list.length < MIN_CHARGES) continue;

    const sorted = [...list].sort((a, b) => (a.at < b.at ? -1 : 1));

    // Amount stability. Varying amounts mean purchases, not a subscription.
    const amounts = sorted.map((c) => c.amount);
    const lo = Math.min(...amounts);
    const hi = Math.max(...amounts);
    if (lo <= 0 || hi / lo > MAX_AMOUNT_SPREAD) continue;

    // Spacing regularity. Several charges in one week is a spending habit.
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(Math.round((Date.parse(sorted[i].at) - Date.parse(sorted[i - 1].at)) / 86_400_000));
    }
    if (!gaps.length) continue;
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

    const cadence = CADENCES.find((c) => Math.abs(avgGap - c.days) <= c.tolerance);
    if (!cadence) continue;
    // And every gap must fit, not just the average — one charge a month for
    // three months averages the same as three in a day and then nothing.
    if (!gaps.every((g) => Math.abs(g - cadence.days) <= cadence.tolerance)) continue;

    const last = sorted.at(-1)!;
    const next = new Date(Date.parse(last.at) + cadence.days * 86_400_000);

    inferences.push({
      merchantKey: key,
      label: last.merchant,
      amount: Math.round((amounts.reduce((a, b) => a + b, 0) / amounts.length) * 100) / 100,
      cadence: cadence.name,
      cadenceDays: cadence.days,
      charges: sorted.length,
      lastChargedAt: last.at,
      nextExpected: next.toISOString().slice(0, 10),
      signalIds: sorted.map((c) => c.signalId),
    });
  }

  return inferences.sort((a, b) => (a.nextExpected < b.nextExpected ? -1 : 1));
}

export function inferenceToDraft(inf: RecurringInference): ObligationDraft {
  return {
    kind: 'renewal',
    counterparty: inf.merchantKey,
    counterpartyLabel: inf.label,
    amount: inf.amount,
    currency: 'INR',
    dueDate: inf.nextExpected,
    decision: 'undecided',
    serviceStatus: 'ok',
    evidence: inf.signalIds,
    sourceParser: 'recurring-inference@1',
  };
}

const SUSPENDED = /\bsuspend(?:ed|s|ing|sion)?\b|account (?:has been )?(?:disabled|locked)/i;
const PAYMENT_FAILED =
  /payment (?:has )?failed|payment issue|balance is too low|past due|declined|could not (?:be )?process/i;
const EXPIRING = /expired?|expiring|will renew|renews on|cancel(?:led|lation)?/i;

/**
 * Renewals stated outright in a message. These are the ones that were provably
 * costing him money while unread: three separate services in a suspended or
 * payment-failed state, none of them opened.
 */
export function renewalsFromSignals(results: TriageResult[], now = new Date()): ObligationDraft[] {
  const drafts: ObligationDraft[] = [];
  for (const r of results) {
    if (r.classification.category !== 'renewal') continue;
    const text = r.signal.text;
    const status: ServiceStatus = SUSPENDED.test(text)
      ? 'suspended'
      : PAYMENT_FAILED.test(text)
        ? 'payment_failed'
        : 'ok';
    if (status === 'ok' && !EXPIRING.test(text)) continue;

    const vendor = r.signal.senderDomain.replace(/^(?:mail|email|no-?reply|www)\./, '');
    const amount = r.extractions.find((e) => e.kind === 'amount' && typeof e.valueNum === 'number')?.valueNum;
    // Not simply the first date in the message. A Google Play receipt is
    // headed with the date it was issued and mentions the renewal date in the
    // body; taking the first one reported a subscription as 22 days overdue
    // when it actually renews next month.
    const due = datedCandidates(r.signal, now).find((c) => c.explicit)?.date
      ?? datedCandidates(r.signal, now)[0]?.date;

    drafts.push({
      kind: 'renewal',
      counterparty: normaliseCounterparty(vendor),
      counterpartyLabel: vendor,
      amount,
      currency: 'INR',
      dueDate: due,
      decision: 'undecided',
      serviceStatus: status,
      evidence: [r.signal.externalId],
      sourceParser: 'renewal-signal@1',
    });
  }
  return drafts;
}
