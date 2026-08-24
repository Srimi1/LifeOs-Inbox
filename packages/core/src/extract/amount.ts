import type { Extraction } from '../signal.ts';
import { evidenced, scan, dedupeExtractions } from './util.ts';

const V = 'amount@1';

/**
 * Indian rupee amounts as they actually appear in his mail:
 *   Rs.361.00 · Rs. 60000 · ₹1,249 · ₹1590.25 · INR 1000 · ₹ 10,000
 * Lakh/crore words are deliberately not parsed — they appear only in marketing
 * copy ("Unlock ₹1 Lakh in minutes"), never in a real bill.
 */
const AMOUNT = /(?:₹|Rs\.?|INR)\s?([0-9](?:[0-9,]*)(?:\.[0-9]{1,2})?)/gi;

/** Labels that mark an amount as the thing you actually owe. */
const TOTAL_LABEL = /\b(?:amount\s+due|total\s+due|total\s+amount\s+due|outstanding(?:\s+amount)?|bill\s+amount|amount\s+payable)\b/i;
const MIN_LABEL = /\b(?:min(?:imum)?\.?\s+(?:amount\s+)?due|min\s+due)\b/i;

export function parseRupees(s: string): number | null {
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function amountAt(text: string, m: RegExpExecArray, kind: 'amount' | 'min_due'): Extraction | null {
  const value = parseRupees(m[1]);
  if (value === null) return null;
  return evidenced(text, kind, m[0], m.index, { valueNum: value, currency: 'INR' }, V);
}

/**
 * Amounts found anywhere in the text, plus the labelled total/minimum when the
 * label sits within ~40 characters before the figure. Order is source order, so
 * the first labelled total is the one a bill parser should trust.
 */
export function extractAmounts(text: string): Extraction[] {
  const all = scan(text, AMOUNT, (m) => amountAt(text, m, 'amount'));

  const labelled: Extraction[] = [];
  for (const e of all) {
    const before = text.slice(Math.max(0, e.offset - 40), e.offset);
    if (MIN_LABEL.test(before)) {
      labelled.push({ ...e, kind: 'min_due' });
    } else if (TOTAL_LABEL.test(before)) {
      // Re-emit as a high-priority total; the plain `amount` copy stays too so
      // downstream code can still see every figure in the mail.
      labelled.push({ ...e, kind: 'amount', valueText: 'total_due' });
    }
  }
  return dedupeExtractions([...labelled, ...all]);
}

/** The figure a bill should bill you for: labelled total first, else the largest. */
export function primaryAmount(list: Extraction[]): Extraction | undefined {
  const labelled = list.find((e) => e.kind === 'amount' && e.valueText === 'total_due');
  if (labelled) return labelled;
  const amounts = list.filter((e) => e.kind === 'amount' && typeof e.valueNum === 'number');
  if (!amounts.length) return undefined;
  return amounts.reduce((a, b) => ((b.valueNum ?? 0) > (a.valueNum ?? 0) ? b : a));
}
