import type { Extraction } from '../signal.ts';
import { evidenced, scan, dedupeExtractions } from './util.ts';

const V = 'date@1';

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const MON = 'jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec';

/** Labels that turn a bare date into a deadline. */
const DUE_LABEL =
  /\b(?:due\s*date|payment\s+due|pending\s+due\s+date|due\s+(?:on|by)|last\s+date|last\s+day|closes?\s+on|valid\s+(?:till|until|upto)|expires?\s+on|before)\b/i;

/**
 * Dates are the highest-stakes extraction in the product: a wrong due date is
 * the single worst error LifeOS can make. So every branch here is explicit,
 * every result is range-checked, and anything ambiguous is simply not emitted.
 *
 * Numeric dates are read DD-MM-YYYY. That is the Indian convention and it is
 * what his mail uses ("24-08-26" for 24 August). A numeric date whose first
 * field is >12 confirms the reading; one where both fields are <=12 is
 * genuinely ambiguous and is emitted with `valueText: 'ambiguous_dmy'` so a
 * caller can require corroboration before trusting it as a deadline.
 */
function iso(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y.toString().padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function expandYear(raw: string): number {
  const n = Number(raw);
  if (raw.length === 4) return n;
  return n <= 79 ? 2000 + n : 1900 + n;
}

/** `9th Sep 2026` · `17 Aug 2026` · `23 Aug, 2026` */
const DMY_WORD = new RegExp(
  String.raw`\b(\d{1,2})(?:st|nd|rd|th)?[\s-]+(${MON})[a-z]*\.?,?[\s-]+(\d{4}|\d{2})\b`,
  'gi',
);
/** `Sep 9, 2026` · `August 30 2026` */
const MDY_WORD = new RegExp(
  String.raw`\b(${MON})[a-z]*\.?[\s-]+(\d{1,2})(?:st|nd|rd|th)?,?[\s-]+(\d{4}|\d{2})\b`,
  'gi',
);
/** `24-08-26` · `25-08-2026` · `10/08/2026` */
const DMY_NUM = /\b(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{4}|\d{2})\b/g;
/** `2026-08-24` */
const ISO_NUM = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

export function extractDates(text: string): Extraction[] {
  const out: Extraction[] = [];

  out.push(
    ...scan(text, DMY_WORD, (m) => {
      const d = iso(expandYear(m[3]), MONTHS[m[2].toLowerCase()], Number(m[1]));
      return d ? evidenced(text, 'due_date', m[0], m.index, { valueDate: d }, V) : null;
    }),
  );

  out.push(
    ...scan(text, MDY_WORD, (m) => {
      const d = iso(expandYear(m[3]), MONTHS[m[1].toLowerCase()], Number(m[2]));
      return d ? evidenced(text, 'due_date', m[0], m.index, { valueDate: d }, V) : null;
    }),
  );

  out.push(
    ...scan(text, ISO_NUM, (m) => {
      const d = iso(Number(m[1]), Number(m[2]), Number(m[3]));
      return d ? evidenced(text, 'due_date', m[0], m.index, { valueDate: d }, V) : null;
    }),
  );

  out.push(
    ...scan(text, DMY_NUM, (m) => {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const y = expandYear(m[3]);
      // Read as DD-MM. If the first field cannot be a day-of-month in the
      // other reading either, the date is malformed and we drop it entirely.
      const d = iso(y, b, a);
      if (!d) return null;
      const ambiguous = a <= 12 && b <= 12;
      return evidenced(
        text,
        'due_date',
        m[0],
        m.index,
        ambiguous ? { valueDate: d, valueText: 'ambiguous_dmy' } : { valueDate: d },
        V,
      );
    }),
  );

  return dedupeExtractions(out);
}

/** True when a due-style label sits just before the date. */
export function isLabelledDue(text: string, e: Extraction): boolean {
  return DUE_LABEL.test(text.slice(Math.max(0, e.offset - 48), e.offset));
}

/**
 * The date a bill is actually due: the first labelled one, else the earliest
 * unambiguous future date. Returns undefined rather than guessing.
 */
export function primaryDueDate(text: string, list: Extraction[], now = new Date()): Extraction | undefined {
  const dates = list.filter((e) => e.kind === 'due_date' && e.valueDate);
  if (!dates.length) return undefined;

  const today = now.toISOString().slice(0, 10);
  const asc = (a: Extraction, b: Extraction) => (a.valueDate! < b.valueDate! ? -1 : 1);
  // An ambiguous DD/MM reading is never promoted to THE due date. The policy
  // already said such dates need corroboration; the labelled branch simply
  // never checked, so "due date: 03-04-26" was returned as fact.
  const confident = (e: Extraction) => e.valueText !== 'ambiguous_dmy';

  const labelled = dates.filter((e) => isLabelledDue(text, e) && confident(e));
  if (labelled.length) {
    // Indian card statements quote the previous cycle's dates alongside this
    // one's. Taking the earliest labelled date reported a bill as already
    // overdue while the real deadline was weeks away — so a future date always
    // wins, and only when every candidate is past do we fall back, to the most
    // recent of them rather than the oldest.
    const future = labelled.filter((e) => e.valueDate! >= today).sort(asc);
    return future[0] ?? labelled.sort(asc).at(-1);
  }

  return dates.filter((e) => confident(e) && e.valueDate! >= today).sort(asc)[0];
}

export function daysUntil(isoDate: string, now = new Date()): number {
  const then = Date.UTC(
    Number(isoDate.slice(0, 4)),
    Number(isoDate.slice(5, 7)) - 1,
    Number(isoDate.slice(8, 10)),
  );
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((then - today) / 86_400_000);
}
