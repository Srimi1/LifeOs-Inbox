import type { Signal } from '../signal.ts';

/**
 * Repeated identical machine mail, collapsed.
 *
 * The same two GitHub workflows failed every day for eight days on the same
 * commit: sixteen unread emails saying one thing. Gmail showed him all sixteen
 * and he read none, which is the failure mode in miniature — volume is not
 * information. A streak is one line with a count and a duration, and it says
 * the thing the sixteen emails were collectively trying to say.
 *
 * The key is sender plus a subject with every varying token masked, so this
 * works for any repeating notifier, not just CI.
 */
export interface Streak {
  key: string;
  senderAddr: string;
  /** A representative subject, taken from the most recent occurrence. */
  subject: string;
  count: number;
  firstAt: string;
  lastAt: string;
  /** Distinct calendar days the streak spans, in the given timezone offset. */
  spanDays: number;
  signalIds: string[];
}

/** Mask the parts that change between otherwise-identical notifications. */
export function streakKey(sig: Signal): string {
  const masked = sig.title
    // Commit shas, build ids, uuids.
    .replace(/\b[0-9a-f]{7,40}\b/gi, '#')
    .replace(/\b\d[\d,.]*\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `${sig.senderAddr}::${masked}`;
}

function dayStamp(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Collapse groups of `minCount` or more. Everything below the threshold is
 * returned untouched — two copies of a thing is a coincidence, not a streak.
 */
export function collapseStreaks(
  signals: Signal[],
  minCount = 3,
): { streaks: Streak[]; singles: Signal[] } {
  const groups = new Map<string, Signal[]>();
  for (const sig of signals) {
    const k = streakKey(sig);
    const list = groups.get(k);
    if (list) list.push(sig);
    else groups.set(k, [sig]);
  }

  const streaks: Streak[] = [];
  const singles: Signal[] = [];

  for (const [key, list] of groups) {
    if (list.length < minCount) {
      singles.push(...list);
      continue;
    }
    const sorted = [...list].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
    const days = new Set(sorted.map((s) => dayStamp(s.occurredAt)));
    streaks.push({
      key,
      senderAddr: sorted[0].senderAddr,
      subject: sorted[sorted.length - 1].title,
      count: sorted.length,
      firstAt: sorted[0].occurredAt,
      lastAt: sorted[sorted.length - 1].occurredAt,
      spanDays: days.size,
      signalIds: sorted.map((s) => s.externalId),
    });
  }

  streaks.sort((a, b) => b.count - a.count);
  return { streaks, singles };
}

/**
 * "github-metrics + refresh-contributors-wall have failed every day for 8 days"
 *
 * Streaks from one sender are merged into a single sentence, because the
 * reader's question is "is my CI broken?", not "which workflow files exist".
 */
export function describeStreakGroup(streaks: Streak[]): string {
  if (!streaks.length) return '';
  const total = streaks.reduce((n, s) => n + s.count, 0);
  const span = Math.max(...streaks.map((s) => s.spanDays));
  const labels = streaks.map(shortLabel).filter(Boolean);
  const subject = labels.length ? labels.join(' + ') : streaks[0].subject;
  const daily = span > 1 && total >= span * streaks.length;
  return (
    `${subject} — ${daily ? 'failing every day for' : 'repeated across'} ` +
    `${span} day${span === 1 ? '' : 's'} (${total} emails → 1 line)`
  );
}

/** Pull the distinguishing fragment out of a notifier subject. */
function shortLabel(s: Streak): string {
  // Hyphens are part of workflow names, so the token must not stop at one —
  // the first version reported "refresh" instead of "refresh-contributors-wall".
  const runFailed = s.subject.match(/Run failed:\s*([\w.\-]+)/i);
  if (runFailed) return runFailed[1];
  const bracketed = s.subject.match(/^\[([^\]]+)\]\s*(.+)$/);
  if (bracketed) return bracketed[2].slice(0, 40);
  return s.subject.slice(0, 40);
}
