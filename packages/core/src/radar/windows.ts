import type { Signal, Extraction } from '../signal.ts';
import { extractDates, isLabelledDue } from '../extract/date.ts';

/**
 * Some deadlines are windows, not moments.
 *
 * The CDSL e-voting notice in his mailbox reads "will be OPEN FROM 25-08-2026
 * 09:00 TO 27-08-2026 17:00 AND Meeting ON 28-08-2026 11:30". Taking the first
 * date found gives 25 August, which is when voting *opens* — the least useful
 * of the three. What he needs to know is that it shuts on the 27th, because
 * that is the moment the option disappears.
 *
 * A window has an opening he can ignore and a closing he cannot.
 */
export type DeadlineKind = 'pay' | 'vote' | 'decide' | 'attend' | 'submit' | 'expire' | 'other';

export interface DateWindow {
  opensAt?: string;
  /** The actionable edge: after this the opportunity is gone. */
  closesAt: string;
  evidence: string;
  offset: number;
}

const WINDOW_PATTERNS: RegExp[] = [
  // "OPEN FROM 25-08-2026 09:00 TO 27-08-2026 17:00"
  /\bfrom\s+(.{6,24}?)\s+to\s+(.{6,24}?)(?=\s|$|\.|,|and\b)/gi,
  // "25 Aug - 27 Aug", "Aug 28 - Sep 4"
  /\b(.{5,22}?)\s*[-–—]\s*(.{5,22}?)(?=\s|$|\.|,)/g,
  // "between 25 August and 27 August"
  /\bbetween\s+(.{5,22}?)\s+and\s+(.{5,22}?)(?=\s|$|\.|,)/gi,
];

/** Words that mark the *closing* edge even without a range. */
const CLOSES =
  /\b(?:last date|last day|closes?(?: on)?|closing|deadline|due (?:date|on|by)|expires? on|valid (?:till|until|upto)|before|by)\b/i;

const KIND_PATTERNS: { kind: DeadlineKind; re: RegExp }[] = [
  { kind: 'vote', re: /\be-?voting|ballot|resolution|shareholder/i },
  { kind: 'pay', re: /\bbill|amount due|payment due|outstanding|pay now|late fee/i },
  { kind: 'decide', re: /\brenew|subscription|auto-?renew|cancel|trial ends/i },
  { kind: 'expire', re: /\bexpires?|expiry|lapses?|will be suspended/i },
  { kind: 'attend', re: /\bmeeting|webinar|session|workshop|interview|call on/i },
  { kind: 'submit', re: /\bapplic|register|registration|submit|enrol|cohort|hackathon|admission|closes/i },
];

export function classifyDeadline(text: string): DeadlineKind {
  for (const { kind, re } of KIND_PATTERNS) if (re.test(text)) return kind;
  return 'other';
}

function firstDateIn(fragment: string): Extraction | undefined {
  return extractDates(fragment).find((e) => e.valueDate && e.valueText !== 'ambiguous_dmy');
}

/**
 * Find explicit ranges. Only a pair where both halves parse as dates and the
 * second is not before the first counts — a hyphen between two numbers is far
 * more often a phone number or an order id than a date range.
 */
export function extractWindows(text: string): DateWindow[] {
  const out: DateWindow[] = [];
  for (const pattern of WINDOW_PATTERNS) {
    const rx = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = rx.exec(text)) !== null && guard++ < 60) {
      const a = firstDateIn(m[1]);
      const b = firstDateIn(m[2]);
      if (!a?.valueDate || !b?.valueDate) continue;
      if (b.valueDate < a.valueDate) continue;
      if (a.valueDate === b.valueDate) continue;
      out.push({
        opensAt: a.valueDate,
        closesAt: b.valueDate,
        evidence: m[0].trim().slice(0, 110),
        offset: m.index,
      });
    }
  }
  // Keep the earliest-closing window per closing date.
  const seen = new Map<string, DateWindow>();
  for (const w of out) if (!seen.has(w.closesAt)) seen.set(w.closesAt, w);
  return [...seen.values()].sort((a, b) => (a.closesAt < b.closesAt ? -1 : 1));
}

export interface DatedCandidate {
  date: string;
  kind: DeadlineKind;
  evidence: string;
  /** True when a window, a due-label or an explicit closing word marked it. */
  explicit: boolean;
  opensAt?: string;
}

/**
 * Every future date in a message that plausibly represents something the owner
 * must act before, with the strongest reading preferred: an explicit window
 * beats a labelled due date, which beats a bare date sitting in the text.
 */
export function datedCandidates(sig: Signal, now = new Date()): DatedCandidate[] {
  const today = now.toISOString().slice(0, 10);
  const text = sig.text;
  const kind = classifyDeadline(text);
  const out: DatedCandidate[] = [];

  for (const w of extractWindows(text)) {
    if (w.closesAt < today) continue;
    out.push({ date: w.closesAt, kind, evidence: w.evidence, explicit: true, opensAt: w.opensAt });
  }

  for (const e of extractDates(text)) {
    if (!e.valueDate || e.valueText === 'ambiguous_dmy') continue;
    if (e.valueDate < today) continue;
    if (out.some((c) => c.date === e.valueDate)) continue;
    const before = text.slice(Math.max(0, e.offset - 48), e.offset);
    const explicit = isLabelledDue(text, e) || CLOSES.test(before);
    out.push({ date: e.valueDate, kind, evidence: e.evidence, explicit });
  }

  // An explicit reading of a date always beats an incidental one, and earlier
  // beats later — the first thing to expire is the one that needs attention.
  return out.sort(
    (a, b) => Number(b.explicit) - Number(a.explicit) || (a.date < b.date ? -1 : 1),
  );
}
