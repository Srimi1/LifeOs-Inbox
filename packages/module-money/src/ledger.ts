import { createHash } from 'node:crypto';
import type { TriageResult } from '../../core/src/triage.ts';
import type { ObligationDraft, ObligationStatus, RenewalDecision, ServiceStatus } from '../../core/src/obligation.ts';
import { mergeVerdict } from '../../core/src/obligation.ts';
import { daysUntil } from '../../core/src/extract/date.ts';

/**
 * The ledger is derived, not stored.
 *
 * Every obligation is recomputed from the signals that support it, so the
 * ledger can never drift away from the mail it claims to summarise — replaying
 * the corpus always produces the same answer. What genuinely cannot be derived
 * is what the owner *did*: marking a bill paid, deciding to cancel a
 * subscription. That lives in a small overlay which is applied last and which
 * nothing in the pipeline may overwrite.
 *
 * Same shape as corrections outranking classifiers, one layer down.
 */
export interface LedgerEntry {
  id: string;
  kind: 'bill' | 'renewal' | 'deadline';
  counterparty: string;
  label: string;
  amount?: number;
  currency: string;
  dueDate?: string;
  daysUntil?: number;
  cardLast4?: string;
  status: ObligationStatus;
  decision?: RenewalDecision;
  serviceStatus?: ServiceStatus;
  /** Signal ids that support this entry — the lineage shown on hover. */
  evidence: string[];
  sources: string[];
  /** Set when two sources disagree about the same obligation. */
  conflict?: { field: 'amount' | 'dueDate'; values: string[]; sources: string[] };
  /** Same counterparty, close but not close enough to merge automatically. */
  possibleDuplicateOf?: string;
}

export interface LedgerOverlay {
  /** obligationId -> ISO timestamp. */
  paid: Record<string, string>;
  /** counterparty -> keep | cancel. */
  decisions: Record<string, RenewalDecision>;
  dismissed: string[];
}

export const EMPTY_OVERLAY: LedgerOverlay = { paid: {}, decisions: {}, dismissed: [] };

/**
 * A stable id. Keyed on the merge identity rather than the source message, so
 * the same bill arriving from SaveSage and from the issuer lands on one row.
 */
export function obligationId(d: Pick<ObligationDraft, 'kind' | 'counterparty' | 'dueDate'>): string {
  const h = createHash('sha256')
    .update(`${d.kind}:${d.counterparty}:${d.dueDate ?? 'undated'}`)
    .digest('hex')
    .slice(0, 12);
  return `${d.kind}_${h}`;
}

function statusFor(dueDate: string | undefined, paidAt: string | undefined, now: Date): ObligationStatus {
  if (paidAt) return 'paid';
  if (!dueDate) return 'predicted';
  const n = daysUntil(dueDate, now);
  if (n < 0) return 'overdue';
  if (n <= 5) return 'due_soon';
  return 'upcoming';
}

/**
 * Source precedence when two parsers describe the same obligation.
 *
 * The issuer is authoritative about its own bill; an aggregator is a
 * convenience layer on top and can lag or drift. Where they disagree we keep
 * the issuer's number, keep the other in lineage, and surface the conflict
 * rather than silently picking — a bill the product is quietly wrong about is
 * worse than one it admits uncertainty on.
 */
const SOURCE_RANK: Record<string, number> = {
  'hdfc-statement@1': 3,
  'issuer-fallback@1': 3,
  'savesage@1': 2,
  'razorpay@1': 1,
  manual: 4,
};

function rank(parser: string): number {
  return SOURCE_RANK[parser] ?? 0;
}

export interface BuildOptions {
  now?: Date;
  overlay?: LedgerOverlay;
  /** Extra drafts not derived from signals (inferred renewals, manual entries). */
  extraDrafts?: { draft: ObligationDraft; signalIds?: string[] }[];
}

export function buildLedger(results: TriageResult[], opts: BuildOptions = {}): LedgerEntry[] {
  const now = opts.now ?? new Date();
  const overlay = opts.overlay ?? EMPTY_OVERLAY;

  const drafts: ObligationDraft[] = [
    ...results.filter((r) => r.obligation).map((r) => r.obligation!),
    ...(opts.extraDrafts ?? []).map((e) => e.draft),
  ];

  const entries: LedgerEntry[] = [];

  for (const draft of drafts) {
    const existing = entries.find(
      (e) =>
        mergeVerdict(
          { ...draft },
          {
            kind: e.kind,
            counterparty: e.counterparty,
            counterpartyLabel: e.label,
            amount: e.amount,
            dueDate: e.dueDate,
            evidence: e.evidence,
            sourceParser: e.sources[0] ?? '',
          },
        ) === 'match',
    );

    if (existing) {
      mergeInto(existing, draft);
      continue;
    }

    // Not a match — but is it close enough to be worth a human glance?
    const near = entries.find(
      (e) =>
        e.kind === draft.kind &&
        e.counterparty === draft.counterparty &&
        mergeVerdict(
          { ...draft },
          {
            kind: e.kind,
            counterparty: e.counterparty,
            counterpartyLabel: e.label,
            amount: e.amount,
            dueDate: e.dueDate,
            evidence: e.evidence,
            sourceParser: e.sources[0] ?? '',
          },
        ) === 'near',
    );

    entries.push({
      id: obligationId(draft),
      kind: draft.kind,
      counterparty: draft.counterparty,
      label: draft.counterpartyLabel,
      amount: draft.amount,
      currency: draft.currency ?? 'INR',
      dueDate: draft.dueDate,
      cardLast4: draft.cardLast4,
      status: 'upcoming',
      decision: draft.decision,
      serviceStatus: draft.serviceStatus,
      evidence: [...draft.evidence],
      sources: [draft.sourceParser],
      possibleDuplicateOf: near?.id,
    });
  }

  for (const e of entries) {
    e.daysUntil = e.dueDate ? daysUntil(e.dueDate, now) : undefined;
    e.status = statusFor(e.dueDate, overlay.paid[e.id], now);
    if (overlay.decisions[e.counterparty]) e.decision = overlay.decisions[e.counterparty];
  }

  return entries
    .filter((e) => !overlay.dismissed.includes(e.id))
    .sort(worstFirst);
}

function mergeInto(target: LedgerEntry, draft: ObligationDraft): void {
  for (const id of draft.evidence) if (!target.evidence.includes(id)) target.evidence.push(id);
  if (!target.sources.includes(draft.sourceParser)) target.sources.push(draft.sourceParser);

  // Templates name the same card with varying specificity ("Axis" vs "Axis
  // Atlas"). Keep the most informative one for display.
  if (draft.counterpartyLabel.length > target.label.length) target.label = draft.counterpartyLabel;

  const incoming = rank(draft.sourceParser);
  const current = rank(target.sources[0] ?? '');

  if (typeof draft.amount === 'number' && typeof target.amount === 'number') {
    const differs = Math.abs(draft.amount - target.amount) > 0.01;
    if (differs) {
      target.conflict = {
        field: 'amount',
        values: [String(target.amount), String(draft.amount)],
        sources: [...target.sources],
      };
    }
  }

  if (incoming > current) {
    if (typeof draft.amount === 'number') target.amount = draft.amount;
    if (draft.dueDate) target.dueDate = draft.dueDate;
    target.sources = [draft.sourceParser, ...target.sources.filter((s) => s !== draft.sourceParser)];
  } else {
    target.amount ??= draft.amount;
    target.dueDate ??= draft.dueDate;
    target.cardLast4 ??= draft.cardLast4;
  }
  target.cardLast4 ??= draft.cardLast4;
  target.serviceStatus ??= draft.serviceStatus;
}

/** Overdue first, then soonest due, then unscheduled. Money before everything. */
function worstFirst(a: LedgerEntry, b: LedgerEntry): number {
  const sev = (e: LedgerEntry): number => {
    if (e.status === 'paid') return 5;
    if (e.serviceStatus === 'suspended' || e.serviceStatus === 'payment_failed') return 0;
    if (e.status === 'overdue') return 1;
    if (e.status === 'due_soon') return 2;
    if (e.status === 'upcoming') return 3;
    return 4;
  };
  const d = sev(a) - sev(b);
  if (d !== 0) return d;
  return (a.daysUntil ?? 9999) - (b.daysUntil ?? 9999);
}

export function totalOutstanding(entries: LedgerEntry[]): number {
  return entries
    .filter((e) => e.kind === 'bill' && e.status !== 'paid' && typeof e.amount === 'number')
    .reduce((n, e) => n + e.amount!, 0);
}
