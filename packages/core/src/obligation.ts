/**
 * One model spans bills, renewals and deadlines.
 *
 * A bill means "pay X by D" and missing it costs interest. A renewal means
 * "decide keep or cancel before D" and missing it bleeds silently — or
 * suspends the service, which happened three times unread. Same shape, two
 * verbs, so they live in one table with two renewal-only fields.
 */
export type ObligationKind = 'bill' | 'renewal' | 'deadline';
export type ObligationStatus = 'predicted' | 'upcoming' | 'due_soon' | 'paid' | 'overdue' | 'closed';
export type RenewalDecision = 'keep' | 'cancel' | 'undecided';
export type ServiceStatus = 'ok' | 'payment_failed' | 'suspended';

export interface ObligationDraft {
  kind: ObligationKind;
  /** Normalised: lowercase, legal suffixes stripped. The merge key. */
  counterparty: string;
  counterpartyLabel: string;
  amount?: number;
  currency?: string;
  dueDate?: string;
  cardLast4?: string;
  decision?: RenewalDecision;
  serviceStatus?: ServiceStatus;
  /** Signal ids that support this obligation — the lineage shown in the UI. */
  evidence: string[];
  sourceParser: string;
}

const LEGAL_SUFFIX =
  /\b(private limited|pvt\.? ?ltd\.?|limited|ltd\.?|llp|inc\.?|corp\.?|technologies|solutions|services|india)\b/gi;

export function normaliseCounterparty(raw: string): string {
  return raw
    .toLowerCase()
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Deterministic merge. No model is involved in deciding whether two signals
 * describe the same obligation, because a wrong merge hides a real bill.
 *
 * Match  = same kind + counterparty, due dates within a day, amounts within 5%.
 * Near   = same counterparty but 5 days / 15% apart — surfaced as a possible
 *          duplicate for a one-click human merge, never merged automatically.
 * Apart  = more than 15% different in amount is always a distinct obligation.
 */
export type MergeVerdict = 'match' | 'near' | 'distinct';

export function mergeVerdict(a: ObligationDraft, b: ObligationDraft): MergeVerdict {
  if (a.kind !== b.kind || a.counterparty !== b.counterparty) return 'distinct';

  const dayGap =
    a.dueDate && b.dueDate
      ? Math.abs(Date.parse(a.dueDate + 'T00:00:00Z') - Date.parse(b.dueDate + 'T00:00:00Z')) / 86_400_000
      : undefined;

  const ratio =
    typeof a.amount === 'number' && typeof b.amount === 'number' && Math.max(a.amount, b.amount) > 0
      ? Math.abs(a.amount - b.amount) / Math.max(a.amount, b.amount)
      : undefined;

  if (ratio !== undefined && ratio > 0.15) return 'distinct';
  if ((dayGap === undefined || dayGap <= 1) && (ratio === undefined || ratio <= 0.05)) return 'match';
  if ((dayGap ?? 0) <= 5 || (ratio ?? 0) <= 0.15) return 'near';
  return 'distinct';
}
