import type { TriageResult } from '../triage.ts';
import type { Category } from '../taxonomy.ts';
import { daysUntil } from '../extract/date.ts';
import { datedCandidates, type DeadlineKind } from './windows.ts';

export * from './windows.ts';

/**
 * Deadline Radar.
 *
 * This is the Study Pressure Cockpit, generalised. The plan cut that module
 * because a year of search found one real email from his college and his
 * calendar was empty — a module built on it would have shipped a blank screen.
 * What it kept is the skeleton: countdowns, urgency tiers, date extraction,
 * fed by dated obligations that provably exist. Card bills, e-voting windows,
 * cohort cut-offs, renewal decide-by dates.
 *
 * Academic mail is a *source* this view is already waiting for, not a module
 * that has to be built first. If college mail ever starts flowing it appears
 * here the same day, with no new code.
 */
export interface RadarItem {
  id: string;
  title: string;
  kind: DeadlineKind;
  date: string;
  daysUntil: number;
  /** Set for windows: the point after which the option is gone. */
  opensAt?: string;
  source: string;
  /** The verbatim text the date was read from. */
  evidence: string;
  amount?: number;
  currency?: string;
  signalId?: string;
  /** True when a window, due-label or closing word marked the date. */
  explicit: boolean;
}

/** Categories whose dates record what happened rather than what is owed. */
const PAST_TENSE: Set<Category> = new Set(['transaction', 'promo', 'security', 'bounce', 'dev']);

export interface RadarOptions {
  now?: Date;
  /** How far ahead counts as "coming up". */
  horizonDays?: number;
  /**
   * Dated obligations from the modules — card bills, renewals. Core does not
   * import them; they are handed in, same contract as the brief.
   */
  obligations?: {
    id: string;
    label: string;
    kind: 'bill' | 'renewal' | 'deadline';
    dueDate?: string;
    amount?: number;
    currency?: string;
    signalId?: string;
  }[];
  /**
   * Signals already represented by an obligation. Without this a renewal
   * appears twice — once as the ledger entry and once as the raw mail it was
   * derived from, with two different titles for one commitment.
   */
  claimedSignalIds?: string[];
}

export function buildRadar(results: TriageResult[], opts: RadarOptions = {}): RadarItem[] {
  const now = opts.now ?? new Date();
  const horizon = opts.horizonDays ?? 30;
  const items: RadarItem[] = [];

  for (const o of opts.obligations ?? []) {
    if (!o.dueDate) continue;
    const n = daysUntil(o.dueDate, now);
    if (n > horizon) continue;
    items.push({
      id: o.id,
      title: o.label,
      kind: o.kind === 'bill' ? 'pay' : o.kind === 'renewal' ? 'decide' : 'other',
      date: o.dueDate,
      daysUntil: n,
      source: 'ledger',
      evidence: `${o.kind} obligation`,
      amount: o.amount,
      currency: o.currency,
      signalId: o.signalId,
      explicit: true,
    });
  }

  const claimed = new Set(items.map((i) => `${i.date}:${i.title.toLowerCase()}`));
  const claimedSignals = new Set([
    ...(opts.claimedSignalIds ?? []),
    ...(opts.obligations ?? []).map((o) => o.signalId).filter((x): x is string => Boolean(x)),
  ]);

  for (const r of results) {
    if (PAST_TENSE.has(r.classification.category)) continue;
    // A bill already on the ledger must not appear twice under its raw subject.
    if (r.obligation?.dueDate) continue;
    if (claimedSignals.has(r.signal.externalId)) continue;

    const candidates = datedCandidates(r.signal, now);
    if (!candidates.length) continue;

    // One row per message: the strongest, soonest reading. A single mail with
    // five dates in it is one thing to do, not five.
    const best = candidates[0];
    if (!best.explicit && r.classification.urgency === 'none') continue;
    const n = daysUntil(best.date, now);
    if (n > horizon) continue;

    const key = `${best.date}:${r.signal.title.toLowerCase()}`;
    if (claimed.has(key)) continue;
    claimed.add(key);

    items.push({
      id: `sig_${r.signal.externalId}`,
      title: r.signal.title,
      kind: best.kind,
      date: best.date,
      daysUntil: n,
      opensAt: best.opensAt,
      source: r.signal.senderDomain,
      evidence: best.evidence,
      signalId: r.signal.externalId,
      explicit: best.explicit,
    });
  }

  return items.sort((a, b) => a.daysUntil - b.daysUntil || Number(b.explicit) - Number(a.explicit));
}

/**
 * Hours below three days, days above.
 *
 * "41h" reads as pressure in a way "2 days" does not, and the switch happens
 * exactly where the feeling should change.
 */
export function countdown(daysAhead: number, now = new Date(), date?: string): string {
  if (daysAhead < 0) return `${-daysAhead}d overdue`;
  if (daysAhead === 0) return 'today';
  if (daysAhead <= 2 && date) {
    const hours = Math.round((Date.parse(`${date}T23:59:59Z`) - now.getTime()) / 3_600_000);
    if (hours > 0 && hours < 72) return `${hours}h left`;
  }
  if (daysAhead === 1) return 'tomorrow';
  return `${daysAhead}d`;
}

const KIND_VERB: Record<DeadlineKind, string> = {
  pay: 'Pay',
  vote: 'Vote',
  decide: 'Decide',
  attend: 'Attend',
  submit: 'Submit',
  expire: 'Expires',
  other: 'Due',
};

/** Verb-first, because the row is a decision rather than a status. */
export function radarLabel(item: RadarItem): string {
  return `${KIND_VERB[item.kind]}: ${item.title}`;
}

export interface RadarBuckets {
  overdue: RadarItem[];
  today: RadarItem[];
  thisWeek: RadarItem[];
  later: RadarItem[];
}

export function bucketRadar(items: RadarItem[]): RadarBuckets {
  return {
    overdue: items.filter((i) => i.daysUntil < 0),
    today: items.filter((i) => i.daysUntil === 0),
    thisWeek: items.filter((i) => i.daysUntil > 0 && i.daysUntil <= 7),
    later: items.filter((i) => i.daysUntil > 7),
  };
}
