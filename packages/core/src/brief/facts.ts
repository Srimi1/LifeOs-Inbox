import type { TriageResult } from '../triage.ts';
import type { Urgency, Category } from '../taxonomy.ts';
import { isUrgent } from '../taxonomy.ts';
import { daysUntil } from '../extract/date.ts';
import { collapseStreaks, type Streak } from './streaks.ts';
import type { SyncState } from '../store.ts';

/**
 * The brief's facts object.
 *
 * Everything here is derived from stored signals by arithmetic and sorting.
 * No number, date or amount in this structure has ever passed through a model,
 * and the renderer is forbidden from inventing one. When a generative lede is
 * added later it writes prose *around* these values and is handed nothing else
 * — that boundary is what makes a hallucinated due date structurally
 * impossible rather than merely unlikely.
 */
export interface ActNowItem {
  kind: 'bill_due' | 'service_at_risk' | 'dead_channel' | 'urgent_signal';
  title: string;
  detail?: string;
  amount?: number;
  dueDate?: string;
  daysUntil?: number;
  signalId?: string;
  /** Lower sorts first. */
  severity: number;
}

export interface BillView {
  label: string;
  cardLast4?: string;
  amount?: number;
  dueDate: string;
  daysUntil: number;
  signalId: string;
}

export interface RenewalRiskView {
  vendor: string;
  subject: string;
  status: 'payment_failed' | 'suspended' | 'expiring';
  occurredAt: string;
  ageDays: number;
  signalId: string;
}

export interface DeadlineView {
  title: string;
  date: string;
  daysUntil: number;
  source: string;
  evidence: string;
  signalId: string;
}

export interface LoopView {
  counterparty: string;
  subject: string;
  ticketId?: string;
  direction: 'waiting_on_them' | 'i_owe_reply';
  lastActivityAt: string;
  daysSilent: number;
  pastThreshold: boolean;
  /** Mail to this counterparty is bouncing — nudging it would not arrive. */
  dead: boolean;
}

export interface DeadChannelView {
  address: string;
  bounceCount: number;
  firstAt: string;
  lastAt: string;
}

export interface SyncHealth {
  ok: boolean;
  lastSyncAt?: string;
  ageMinutes?: number;
  stale: boolean;
  error?: string;
  /** Set when the brief should carry a [LifeOS ALERT] subject prefix. */
  alert?: string;
}

export interface BriefFacts {
  generatedAt: string;
  actNow: ActNowItem[];
  /**
   * How many urgent items existed before the cap. A brief that quietly shows
   * five of six is doing the thing this product exists to prevent, so the
   * remainder is counted and disclosed rather than dropped.
   */
  actNowTotal: number;
  bills: BillView[];
  billTotal: number;
  billWindowDays: number;
  renewalRisks: RenewalRiskView[];
  deadlines: DeadlineView[];
  loops: LoopView[];
  deadChannels: DeadChannelView[];
  streaks: Streak[];
  noise: { suppressed: number; topSenders: { sender: string; count: number }[] };
  counts: { total: number; unresolved: number; needsCardConfirmation: number; notYours: number };
  sync: SyncHealth;
}

export interface BriefOptions {
  now?: Date;
  /** Bills and deadlines further out than this are not "coming up" yet. */
  windowDays?: number;
  /** Days of silence before a loop is worth nudging. */
  silenceThresholdDays?: number;
  actNowCap?: number;
  loopCap?: number;
  syncStaleHours?: number;
  state?: SyncState;
  /**
   * Supplied by the Follow-Up Desk when that module is loaded. Core keeps its
   * own simpler derivation as a fallback so the brief still works standalone,
   * but it never imports the module — the section is handed in, which is the
   * module contract and the seam that keeps the spine independent.
   */
  waitingOn?: LoopView[];
  deadChannels?: DeadChannelView[];
  /**
   * Supplied by the Money Ledger. Core's own derivation reads obligation
   * drafts straight off each signal and cannot merge them, so three SaveSage
   * templates describing one bill produced three rows and a total inflated by
   * more than double. Merging is the ledger's job; the brief just renders it.
   */
  bills?: BillView[];
}

/** Their dates record what happened, not what is owed. */
const PAST_TENSE_CATEGORIES = new Set<Category>([
  'transaction', 'promo', 'security', 'bounce', 'dev',
]);

const URGENCY_SEVERITY: Record<Urgency, number> = {
  now: 0,
  today: 1,
  this_week: 2,
  someday: 3,
  none: 4,
};

function ageDays(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000));
}

export function buildBriefFacts(results: TriageResult[], opts: BriefOptions = {}): BriefFacts {
  const now = opts.now ?? new Date();
  const windowDays = opts.windowDays ?? 21;
  const silenceThreshold = opts.silenceThresholdDays ?? 7;
  const actNowCap = opts.actNowCap ?? 5;
  const loopCap = opts.loopCap ?? 5;
  const staleHours = opts.syncStaleHours ?? 12;

  // ------------------------------------------------------------------ bills
  const derivedBills: BillView[] = results
    .filter((r) => r.obligation?.kind === 'bill' && r.obligation.dueDate)
    .map((r) => ({
      label: r.obligation!.counterpartyLabel,
      cardLast4: r.obligation!.cardLast4,
      amount: r.obligation!.amount,
      dueDate: r.obligation!.dueDate!,
      daysUntil: daysUntil(r.obligation!.dueDate!, now),
      signalId: r.signal.externalId,
    }))
    .filter((b) => b.daysUntil >= -30 && b.daysUntil <= windowDays)
    .sort((a, b) => a.daysUntil - b.daysUntil);

  const bills = opts.bills
    ? opts.bills.filter((b) => b.daysUntil >= -30 && b.daysUntil <= windowDays).sort((a, b) => a.daysUntil - b.daysUntil)
    : derivedBills;
  const billTotal = bills.reduce((n, b) => n + (b.amount ?? 0), 0);

  // -------------------------------------------------------- renewals at risk
  // Suspension and payment-failure language is the class that was provably
  // costing him money while sitting unread.
  const renewalRisks: RenewalRiskView[] = results
    .filter((r) => r.classification.category === 'renewal' && isUrgent(r.classification.urgency))
    .map((r) => {
      const text = r.signal.text.toLowerCase();
      const status: RenewalRiskView['status'] = /suspend/.test(text)
        ? 'suspended'
        : /payment (?:has )?failed|payment issue|balance is too low|past due/.test(text)
          ? 'payment_failed'
          : 'expiring';
      return {
        vendor: r.signal.senderDomain.replace(/^(mail|email|no-?reply)\./, ''),
        subject: r.signal.title,
        status,
        occurredAt: r.signal.occurredAt,
        ageDays: ageDays(r.signal.occurredAt, now),
        signalId: r.signal.externalId,
      };
    })
    .sort((a, b) => b.ageDays - a.ageDays);

  // -------------------------------------------------------------- deadlines
  // Dated obligations that are not bills: e-voting windows, cohort cut-offs.
  const billIds = new Set(bills.map((b) => b.signalId));
  const deadlines: DeadlineView[] = [];
  for (const r of results) {
    if (billIds.has(r.signal.externalId)) continue;
    // Categories whose dates are past tense, not future obligations. A payment
    // receipt stamped with today's date is a record of something finished —
    // reading it as a deadline put "Withdrawal placed successfully" on the
    // list of things he still had to do.
    if (PAST_TENSE_CATEGORIES.has(r.classification.category)) continue;
    const dated = r.extractions
      .filter((e) => e.kind === 'due_date' && e.valueDate && e.valueText !== 'ambiguous_dmy')
      .map((e) => ({ date: e.valueDate!, evidence: e.evidence }))
      .filter((d) => {
        const n = daysUntil(d.date, now);
        return n >= 0 && n <= windowDays;
      })
      .sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!dated.length) continue;
    deadlines.push({
      title: r.signal.title,
      date: dated[0].date,
      daysUntil: daysUntil(dated[0].date, now),
      source: r.signal.senderDomain,
      evidence: dated[0].evidence,
      signalId: r.signal.externalId,
    });
  }
  deadlines.sort((a, b) => a.daysUntil - b.daysUntil);

  // ------------------------------------------------------------------ loops
  // Group by thread so a five-message escalation is one entry, not five.
  const loopGroups = new Map<string, TriageResult[]>();
  for (const r of results.filter((x) => x.opensLoop)) {
    const key = r.signal.threadKey ?? r.signal.externalId;
    const list = loopGroups.get(key);
    if (list) list.push(r);
    else loopGroups.set(key, [r]);
  }

  const derivedLoops: LoopView[] = [...loopGroups.values()]
    .map((group) => {
      const sorted = [...group].sort((a, b) =>
        a.signal.occurredAt < b.signal.occurredAt ? -1 : 1,
      );
      const latest = sorted[sorted.length - 1];
      const outbound = latest.signal.labels.includes('SENT');
      const counterparty = outbound
        ? (latest.signal.toAddrs[0] ?? 'unknown')
        : latest.signal.senderAddr;
      const ticket = sorted
        .flatMap((r) => r.extractions)
        .find((e) => e.kind === 'ticket_id')?.valueText;
      const silent = ageDays(latest.signal.occurredAt, now);
      return {
        counterparty,
        subject: latest.signal.title,
        ticketId: ticket,
        direction: outbound ? ('waiting_on_them' as const) : ('i_owe_reply' as const),
        lastActivityAt: latest.signal.occurredAt,
        daysSilent: silent,
        pastThreshold: silent >= silenceThreshold,
        dead: false,
      };
    })
    .sort((a, b) => b.daysSilent - a.daysSilent)
    .slice(0, loopCap);

  const loops = opts.waitingOn ? opts.waitingOn.slice(0, loopCap) : derivedLoops;

  // ---------------------------------------------------------- dead channels
  const deadMap = new Map<string, DeadChannelView>();
  for (const r of results.filter((x) => x.classification.category === 'bounce')) {
    const addr = r.extractions.find((e) => e.kind === 'dead_address')?.valueText;
    if (!addr) continue;
    const prev = deadMap.get(addr);
    if (prev) {
      prev.bounceCount++;
      if (r.signal.occurredAt < prev.firstAt) prev.firstAt = r.signal.occurredAt;
      if (r.signal.occurredAt > prev.lastAt) prev.lastAt = r.signal.occurredAt;
    } else {
      deadMap.set(addr, {
        address: addr,
        bounceCount: 1,
        firstAt: r.signal.occurredAt,
        lastAt: r.signal.occurredAt,
      });
    }
  }
  const deadChannels =
    opts.deadChannels ?? [...deadMap.values()].sort((a, b) => b.bounceCount - a.bounceCount);

  // A loop whose counterparty is bouncing is not merely silent — nudging it
  // would not arrive either. Annotate rather than list the address twice.
  const deadSet = new Set(deadChannels.map((d) => d.address));
  for (const l of loops) if (deadSet.has(l.counterparty)) l.dead = true;

  // ---------------------------------------------------------------- streaks
  const { streaks } = collapseStreaks(
    results.filter((r) => r.classification.category === 'dev').map((r) => r.signal),
  );

  // ------------------------------------------------------------------ noise
  const promo = results.filter((r) => r.classification.category === 'promo');
  const senderCounts = new Map<string, number>();
  for (const r of promo) {
    const s = r.signal.senderDomain;
    senderCounts.set(s, (senderCounts.get(s) ?? 0) + 1);
  }
  const topSenders = [...senderCounts.entries()]
    .map(([sender, count]) => ({ sender, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);

  // ------------------------------------------------------------- sync health
  const state = opts.state ?? {};
  const syncAge = state.lastSyncAt
    ? Math.round((now.getTime() - Date.parse(state.lastSyncAt)) / 60_000)
    : undefined;
  const stale = syncAge !== undefined ? syncAge > staleHours * 60 : true;
  const sync: SyncHealth = {
    ok: state.lastSyncOk !== false && !stale,
    lastSyncAt: state.lastSyncAt,
    ageMinutes: syncAge,
    stale,
    error: state.lastError,
    alert:
      state.lastSyncOk === false
        ? `Gmail sync failed: ${state.lastError ?? 'unknown error'}`
        : stale && state.lastSyncAt
          ? `Gmail sync has not run for ${Math.round((syncAge ?? 0) / 60)}h`
          : undefined,
  };

  // ---------------------------------------------------------------- act now
  const actNow: ActNowItem[] = [];

  for (const d of deadChannels) {
    actNow.push({
      kind: 'dead_channel',
      title: `${d.address} is a dead address`,
      detail: `Your last ${d.bounceCount} email${d.bounceCount === 1 ? '' : 's'} there bounced and never arrived.`,
      signalId: d.address,
      severity: 0,
    });
  }

  for (const r of renewalRisks) {
    actNow.push({
      kind: 'service_at_risk',
      title: r.subject,
      detail:
        r.status === 'suspended'
          ? `${r.vendor} — suspended, unread for ${r.ageDays} day${r.ageDays === 1 ? '' : 's'}`
          : `${r.vendor} — payment problem, unread for ${r.ageDays} day${r.ageDays === 1 ? '' : 's'}`,
      signalId: r.signalId,
      severity: 1,
    });
  }

  // A bill enters Act Now at T-3, matching the reminder cadence.
  for (const b of bills.filter((x) => x.daysUntil <= 3)) {
    actNow.push({
      kind: 'bill_due',
      title: `${b.label}${b.cardLast4 ? ` ····${b.cardLast4}` : ''}`,
      detail:
        b.daysUntil < 0
          ? `overdue by ${-b.daysUntil} day${b.daysUntil === -1 ? '' : 's'}`
          : b.daysUntil === 0
            ? 'due today'
            : `due in ${b.daysUntil} day${b.daysUntil === 1 ? '' : 's'}`,
      amount: b.amount,
      dueDate: b.dueDate,
      daysUntil: b.daysUntil,
      signalId: b.signalId,
      severity: b.daysUntil <= 0 ? 0 : 2,
    });
  }

  // Anything the classifier marked urgent that has not already been covered.
  const covered = new Set(actNow.map((a) => a.signalId));
  for (const r of results) {
    if (!isUrgent(r.classification.urgency)) continue;
    if (covered.has(r.signal.externalId)) continue;
    if (['promo', 'security', 'bounce', 'renewal'].includes(r.classification.category)) continue;
    actNow.push({
      kind: 'urgent_signal',
      title: r.signal.title,
      detail: r.signal.senderAddr,
      signalId: r.signal.externalId,
      severity: URGENCY_SEVERITY[r.classification.urgency],
    });
  }

  actNow.sort((a, b) => a.severity - b.severity || (a.daysUntil ?? 99) - (b.daysUntil ?? 99));

  return {
    generatedAt: now.toISOString(),
    actNow: actNow.slice(0, actNowCap),
    actNowTotal: actNow.length,
    bills,
    billTotal,
    billWindowDays: windowDays,
    renewalRisks,
    deadlines,
    loops,
    deadChannels,
    streaks,
    noise: { suppressed: promo.length, topSenders },
    counts: {
      total: results.length,
      unresolved: results.filter((r) => !r.classification.skipLlm).length,
      needsCardConfirmation: results.filter((r) => r.needsCardConfirmation).length,
      notYours: results.filter((r) => r.notYours).length,
    },
    sync,
  };
}
