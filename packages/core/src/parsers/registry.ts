import type { Signal, Extraction } from '../signal.ts';
import type { ObligationDraft } from '../obligation.ts';
import { normaliseCounterparty } from '../obligation.ts';
import { evidenced } from '../extract/util.ts';
import { parseRupees } from '../extract/amount.ts';
import { extractDates } from '../extract/date.ts';

export interface ParseResult {
  extractions: Extraction[];
  obligation?: ObligationDraft;
  /** Set when the parser matched its sender but could not read the body. */
  quarantine?: string;
}

export type Parser = (sig: Signal) => ParseResult;

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function isoFromWordDate(day: string, mon: string, year: string): string | undefined {
  const m = MONTHS[mon.slice(0, 4).toLowerCase()] ?? MONTHS[mon.slice(0, 3).toLowerCase()];
  if (!m) return undefined;
  const y = year.length === 2 ? 2000 + Number(year) : Number(year);
  const d = Number(day);
  if (!m || !d || d > 31) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * SaveSage — the single highest-yield parser in the product.
 *
 * He already forwards every card into one aggregator, so one template covers
 * all four cards. Real body shape:
 *   "… details below. HDFC Biz Grow XXXX 5609 Amount Due ₹7036
 *     Pending Due Date 9th Sep 2026 Your 475 pts are …"
 *
 * This is also the dependency the plan flagged: SaveSage is a third party and
 * a competitor. `quarantine` fires loudly rather than silently returning
 * nothing, so a template change is visible the day it happens.
 */
export const savesage: Parser = (sig) => {
  const t = sig.text;
  const re =
    /((?:[A-Z][A-Za-z0-9&]*\s+){1,4})[Xx]{3,4}\s*(\d{4})\s*Amount\s*Due\s*(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)\s*(?:Pending\s*)?Due\s*Date\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/i;
  const m = t.match(re);
  if (!m || m.index === undefined) {
    return { extractions: [], quarantine: 'savesage: bill block not found in body' };
  }

  const label = m[1].trim();
  const last4 = m[2];
  const amount = parseRupees(m[3]);
  const dueDate = isoFromWordDate(m[4], m[5], m[6]);
  const V = 'savesage@1';

  const extractions = [
    evidenced(t, 'card_last4', `${m[0].match(/[Xx]{3,4}\s*\d{4}/)?.[0] ?? last4}`, m.index, { valueText: last4 }, V),
    amount !== null
      ? evidenced(t, 'amount', m[3], t.indexOf(m[3], m.index), { valueNum: amount, currency: 'INR', valueText: 'total_due' }, V)
      : null,
    dueDate
      ? evidenced(t, 'due_date', `${m[4]}${t.slice(t.indexOf(m[4], m.index) + m[4].length).match(/^(?:st|nd|rd|th)?\s+[A-Za-z]{3,9}\.?,?\s+\d{4}/)?.[0] ?? ''}`, t.indexOf(m[4], m.index), { valueDate: dueDate }, V)
      : null,
  ].filter((e): e is Extraction => e !== null);

  return {
    extractions,
    obligation: {
      kind: 'bill',
      counterparty: normaliseCounterparty(label),
      counterpartyLabel: label,
      amount: amount ?? undefined,
      currency: 'INR',
      dueDate,
      cardLast4: last4,
      evidence: [sig.externalId],
      sourceParser: V,
    },
  };
};

/**
 * Razorpay receipts. Structured and high volume — they are the raw material
 * the money module uses to spot a recurring charge, but a receipt on its own
 * says only that money moved. See the note at the return.
 */
export const razorpay: Parser = (sig) => {
  const t = sig.text;
  const V = 'razorpay@1';
  const amt = t.match(/(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)\s*Paid\s*Successfully/i);
  if (!amt || amt.index === undefined) {
    return { extractions: [], quarantine: 'razorpay: no "₹N Paid Successfully" block' };
  }
  const merchant = t.slice(0, amt.index).trim().split('\n').pop()?.trim() ?? '';
  const amount = parseRupees(amt[1]);
  const payId = t.match(/\bpay_[A-Za-z0-9]+/);
  const method = t.match(/Method\s+(card|upi|netbanking|wallet)/i);
  const tail = t.match(/(?:[Xx]{3,4}[-\s]?){1,3}(\d{4})/);
  const vpa = t.match(/\b[a-z0-9][a-z0-9._\-]+@(?:ok[a-z]+|[a-z]+bank|ybl|paytm|apl|axl)\b/i);

  const extractions = [
    amount !== null
      ? evidenced(t, 'amount', amt[1], t.indexOf(amt[1], amt.index), { valueNum: amount, currency: 'INR' }, V)
      : null,
    merchant ? evidenced(t, 'merchant', merchant, t.indexOf(merchant), { valueText: merchant }, V) : null,
    payId ? evidenced(t, 'ticket_id', payId[0], payId.index!, { valueText: payId[0] }, V) : null,
    tail ? evidenced(t, 'card_last4', tail[0], tail.index!, { valueText: tail[1] }, V) : null,
    vpa ? evidenced(t, 'vpa', vpa[0], vpa.index!, { valueText: vpa[0].toLowerCase() }, V) : null,
  ].filter((e): e is Extraction => e !== null);

  // Deliberately no obligation. A single receipt is money that already moved,
  // not something owed — minting a renewal from one charge put four fictional
  // subscriptions in the ledger, one per gift-card purchase. Recurrence is
  // decided by the money module from the pattern across receipts, never here.
  return { extractions };
};

/**
 * HDFC transaction alerts. Same domain as the statement mail, different local
 * part — and the opposite meaning from the promo subdomain. This parser is the
 * proof that UPI on a credit card is email-covered, which the plan originally
 * got wrong.
 */
export const hdfcAlert: Parser = (sig) => {
  const t = sig.text;
  const V = 'hdfc-alert@1';
  const amt = t.match(/(?:Rs\.?|₹|INR)\s?([\d,]+(?:\.\d{1,2})?)/i);
  if (!amt || amt.index === undefined) {
    return { extractions: [], quarantine: 'hdfc-alert: no rupee amount in body' };
  }
  const amount = parseRupees(amt[1]);
  const rail = /\bUPI\b/i.test(t) ? 'UPI' : /\bcredit card\b/i.test(t) ? 'CARD' : 'UNKNOWN';
  const instrument = t.match(/\b(RuPay Credit Card|Credit Card|Debit Card)\b/i);

  const extractions = [
    amount !== null
      ? evidenced(t, 'amount', amt[0], amt.index, { valueNum: amount, currency: 'INR' }, V)
      : null,
    instrument
      ? evidenced(t, 'merchant', instrument[0], instrument.index!, { valueText: `${rail}:${instrument[0]}` }, V)
      : null,
  ].filter((e): e is Extraction => e !== null);

  return { extractions };
};

/** HDFC e-statement. The figures live in the password-protected PDF (v1.x). */
export const hdfcStatement: Parser = (sig) => {
  const t = sig.text;
  const V = 'hdfc-statement@1';
  const product = t.match(/e-?statement for your ([A-Za-z0-9 ]+?Credit Card)/i)
    ?? sig.title.match(/-\s*([A-Za-z0-9 ]+?Credit Card)\s*Statement/i);
  const dates = extractDates(t);

  const extractions = [
    product ? evidenced(t, 'merchant', product[1].trim(), t.indexOf(product[1].trim()), { valueText: product[1].trim() }, V) : null,
    ...dates,
  ].filter((e): e is Extraction => e !== null);

  const label = product?.[1]?.trim();
  return {
    extractions,
    obligation: label
      ? {
          kind: 'bill',
          counterparty: normaliseCounterparty(label),
          counterpartyLabel: label,
          currency: 'INR',
          evidence: [sig.externalId],
          sourceParser: V,
        }
      : undefined,
    quarantine: label ? undefined : 'hdfc-statement: could not identify card product',
  };
};

export const PARSERS: Record<string, Parser> = {
  savesage,
  razorpay,
  hdfcAlert,
  hdfcStatement,
};
