import type { LedgerEntry } from './ledger.ts';

/**
 * Absence detection.
 *
 * Every other check in this product reacts to a message arriving. This one
 * reacts to a message *not* arriving, which is the failure mode the plan
 * flagged as the price of building the money spine on SaveSage: it is a third
 * party and a competitor, and if it stops emitting, nothing breaks loudly.
 * The bills simply stop appearing and the ledger looks calm and empty.
 *
 * A silent money module is indistinguishable from a month with no bills, so
 * the canary makes silence itself an alert.
 */
export interface KnownCard {
  last4: string;
  label?: string;
  /** Days between statements. Indian card cycles are monthly. */
  cycleDays?: number;
}

export type CanaryKind = 'missing_bill' | 'never_billed' | 'source_silent' | 'source_divergence';

export interface CanaryAlert {
  kind: CanaryKind;
  severity: 'warn' | 'alert';
  title: string;
  detail: string;
  cardLast4?: string;
  source?: string;
}

/** With one observation there is nothing to average, so assume the norm. */
const DEFAULT_CYCLE_DAYS = 30;
/** Statements slip by a few days; alarming on day 31 would cry wolf monthly. */
const GRACE_DAYS = 7;

/**
 * Link a card to a bill.
 *
 * Not every statement names a card tail — the HDFC e-statement identifies the
 * product ("Acme Neo Credit Card") and keeps the number in the
 * password-protected PDF. Matching on the label as well stops the canary
 * reporting a card as never-billed when its statement is sitting right there.
 */
function cardMatches(card: KnownCard, entry: LedgerEntry): boolean {
  if (entry.cardLast4 && entry.cardLast4 === card.last4) return true;
  if (!card.label || entry.cardLast4) return false;
  const tokens = (s: string) =>
    new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && t !== 'card' && t !== 'bank'));
  const want = tokens(card.label);
  const have = tokens(entry.label);
  if (!want.size) return false;
  const overlap = [...want].filter((t) => have.has(t)).length;
  return overlap >= Math.min(2, want.size);
}

function daysBetween(a: string, b: Date): number {
  return Math.floor((b.getTime() - Date.parse(a)) / 86_400_000);
}

function median(ns: number[]): number | undefined {
  if (!ns.length) return undefined;
  const s = [...ns].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export interface CanaryInput {
  entries: LedgerEntry[];
  knownCards: KnownCard[];
  /** When each signal was received, so cadence is measured on arrival. */
  receivedAt: Map<string, string>;
  now: Date;
  /** Parsers expected to be producing bills. Silence from one is an alert. */
  expectedSources?: string[];
}

export function runCanary(input: CanaryInput): CanaryAlert[] {
  const { entries, knownCards, receivedAt, now } = input;
  const alerts: CanaryAlert[] = [];

  const bills = entries.filter((e) => e.kind === 'bill');

  // ---------------------------------------------------------- per-card cover
  for (const card of knownCards) {
    const forCard = bills
      .filter((b) => cardMatches(card, b))
      .map((b) => ({
        entry: b,
        at: b.evidence.map((id) => receivedAt.get(id)).find(Boolean),
      }))
      .filter((x): x is { entry: LedgerEntry; at: string } => Boolean(x.at))
      .sort((a, b) => (a.at < b.at ? -1 : 1));

    const label = card.label ?? forCard.at(-1)?.entry.label ?? `card ····${card.last4}`;

    if (!forCard.length) {
      // A card he demonstrably uses that has never produced a statement. Not
      // necessarily broken — it may be a debit card or the statements go
      // elsewhere — but it is a hole in the money picture worth naming.
      alerts.push({
        kind: 'never_billed',
        severity: 'warn',
        title: `No bill has ever arrived for ····${card.last4}`,
        detail:
          'You have used this card, but no statement for it reaches this inbox. ' +
          'Either it does not issue one here, or the alert is switched off.',
        cardLast4: card.last4,
      });
      continue;
    }

    const gaps: number[] = [];
    for (let i = 1; i < forCard.length; i++) {
      gaps.push(Math.floor((Date.parse(forCard[i].at) - Date.parse(forCard[i - 1].at)) / 86_400_000));
    }
    const cycle = card.cycleDays ?? median(gaps) ?? DEFAULT_CYCLE_DAYS;
    const last = forCard.at(-1)!;
    const since = daysBetween(last.at, now);

    if (since > cycle + GRACE_DAYS) {
      alerts.push({
        kind: 'missing_bill',
        severity: 'alert',
        title: `${label}: no bill in ${since} days`,
        detail:
          `Statements usually arrive about every ${cycle} days. The last one was ` +
          `${since} days ago. Check the card directly — a bill may be due that ` +
          `LifeOS cannot see.`,
        cardLast4: card.last4,
        source: last.entry.sources[0],
      });
    }
  }

  // ------------------------------------------------------- whole-source loss
  // If the aggregator that covers most cards goes quiet, per-card checks fire
  // one at a time over weeks. This catches it in one.
  for (const source of input.expectedSources ?? []) {
    const fromSource = bills.filter((b) => b.sources.includes(source));
    const latest = fromSource
      .flatMap((b) => b.evidence.map((id) => receivedAt.get(id)))
      .filter((x): x is string => Boolean(x))
      .sort()
      .at(-1);

    if (!latest) {
      alerts.push({
        kind: 'source_silent',
        severity: 'alert',
        title: `${source} has produced nothing`,
        detail: 'The primary bill source is not being seen at all. Check that its mail still arrives.',
        source,
      });
      continue;
    }
    const since = daysBetween(latest, now);
    if (since > DEFAULT_CYCLE_DAYS + GRACE_DAYS) {
      alerts.push({
        kind: 'source_silent',
        severity: 'alert',
        title: `${source} has been quiet for ${since} days`,
        detail:
          'This source normally reports every card each month. Silence this long ' +
          'usually means its format changed or the account lapsed — not that you ' +
          'have no bills.',
        source,
      });
    }
  }

  // --------------------------------------------------------- disagreement
  for (const b of bills) {
    if (!b.conflict) continue;
    alerts.push({
      kind: 'source_divergence',
      severity: 'alert',
      title: `${b.label}: sources disagree on ${b.conflict.field}`,
      detail:
        `${b.conflict.values.join(' vs ')} from ${b.conflict.sources.join(' and ')}. ` +
        'Verify in your bank app before paying — LifeOS will not pick one for you.',
      cardLast4: b.cardLast4,
    });
  }

  return alerts;
}
