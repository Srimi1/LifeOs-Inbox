import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { TriageResult } from '../../core/src/triage.ts';
import { buildLedger, totalOutstanding, EMPTY_OVERLAY, type LedgerEntry, type LedgerOverlay } from './ledger.ts';
import { runCanary, type CanaryAlert, type KnownCard } from './canary.ts';
import { chargesFrom, inferRecurring, inferenceToDraft, renewalsFromSignals, type RecurringInference } from './renewals.ts';
import { loadCardTable, knownCardsFrom, whichCard, type CardTable } from './cards.ts';

export * from './ledger.ts';
export * from './canary.ts';
export * from './renewals.ts';
export * from './cards.ts';

/**
 * Money Ledger.
 *
 * The module owns its own state and reads core signals; core never imports
 * this file. That direction is the whole SaaS seam — a second module, or a
 * second tenant, changes nothing in the spine.
 */
const DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));
const OVERLAY_PATH = join(DATA_DIR, 'money-overlay.json');

export function loadOverlay(): LedgerOverlay {
  if (!existsSync(OVERLAY_PATH)) return EMPTY_OVERLAY;
  try {
    const raw = JSON.parse(readFileSync(OVERLAY_PATH, 'utf8')) as Partial<LedgerOverlay>;
    return { paid: raw.paid ?? {}, decisions: raw.decisions ?? {}, dismissed: raw.dismissed ?? [] };
  } catch {
    return EMPTY_OVERLAY;
  }
}

export function saveOverlay(o: LedgerOverlay): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OVERLAY_PATH, JSON.stringify(o, null, 2) + '\n');
}

export function markPaid(id: string, at = new Date().toISOString()): LedgerOverlay {
  const o = loadOverlay();
  o.paid[id] = at;
  saveOverlay(o);
  return o;
}

export function decide(counterparty: string, decision: 'keep' | 'cancel'): LedgerOverlay {
  const o = loadOverlay();
  o.decisions[counterparty] = decision;
  saveOverlay(o);
  return o;
}

export interface MoneyView {
  entries: LedgerEntry[];
  bills: LedgerEntry[];
  renewals: LedgerEntry[];
  atRisk: LedgerEntry[];
  total: number;
  alerts: CanaryAlert[];
  inferred: RecurringInference[];
  cardTable: CardTable;
  knownCards: KnownCard[];
}

export interface MoneyOptions {
  now?: Date;
  overlay?: LedgerOverlay;
  cardTable?: CardTable;
  /** Card tails he holds, from owner.json. Drives canary coverage. */
  ownedCardLast4?: string[];
  expectedSources?: string[];
}

export function buildMoneyView(results: TriageResult[], opts: MoneyOptions = {}): MoneyView {
  const now = opts.now ?? new Date();
  const overlay = opts.overlay ?? EMPTY_OVERLAY;
  const cardTable = opts.cardTable ?? loadCardTable();

  // Recurring charges become renewals before any notice arrives; explicit
  // renewal mail carries the service status that makes them urgent.
  const inferred = inferRecurring(chargesFrom(results), now);
  const extraDrafts = [
    ...inferred.map((i) => ({ draft: inferenceToDraft(i) })),
    ...renewalsFromSignals(results, now).map((d) => ({ draft: d })),
  ];

  const entries = buildLedger(results, { now, overlay, extraDrafts });

  const receivedAt = new Map<string, string>();
  for (const r of results) receivedAt.set(r.signal.externalId, r.signal.occurredAt);

  const seenLast4 = [
    ...new Set(
      results
        .flatMap((r) => r.extractions)
        .filter((e) => e.kind === 'card_last4' && e.valueText)
        .map((e) => e.valueText!),
    ),
  ];
  const owned = opts.ownedCardLast4 ?? [];
  const knownCards = knownCardsFrom(
    cardTable,
    seenLast4.filter((l) => owned.length === 0 || owned.includes(l)),
  );

  const alerts = runCanary({
    entries,
    knownCards,
    receivedAt,
    now,
    expectedSources: opts.expectedSources ?? ['savesage@1'],
  });

  return {
    entries,
    bills: entries.filter((e) => e.kind === 'bill'),
    renewals: entries.filter((e) => e.kind === 'renewal'),
    atRisk: entries.filter((e) => e.serviceStatus === 'suspended' || e.serviceStatus === 'payment_failed'),
    total: totalOutstanding(entries),
    alerts,
    inferred,
    cardTable,
    knownCards,
  };
}

export { whichCard };
