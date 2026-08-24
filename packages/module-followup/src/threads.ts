import type { TriageResult } from '../../core/src/triage.ts';

/**
 * Open loops, derived from thread history.
 *
 * Everything here is deterministic. The plan's earlier ruling stands — asking
 * a model "does this sent message expect a reply?" is the unreliable part and
 * stays deferred. But roughly four fifths of the value needs no classifier at
 * all: who spoke last, how long ago, whether a ticket number is present, and
 * whether the address bounced. Those are queries, not inferences.
 *
 * He already runs this loop by hand — his subject lines literally say "Polite
 * follow-up on ticket #4399615" and his bodies say "This is follow-up #1". The
 * desk is not teaching him a habit; it is doing the bookkeeping the habit
 * already requires.
 */
export type ThreadState = 'open' | 'nudge_due' | 'escalate' | 'dead_channel' | 'closed';
export type Direction = 'waiting_on_them' | 'i_owe_reply';

export interface ThreadMessage {
  signalId: string;
  at: string;
  outbound: boolean;
  subject: string;
}

export interface FollowUpThread {
  threadKey: string;
  counterparty: string;
  subject: string;
  ticketId?: string;
  direction: Direction;
  state: ThreadState;
  messages: ThreadMessage[];
  outboundCount: number;
  lastActivityAt: string;
  lastOutboundAt?: string;
  lastInboundAt?: string;
  daysSilent: number;
  /** Set when mail to this counterparty is bouncing. */
  dead?: { address: string; bounces: number; resendsAfterFirstBounce: number };
  /**
   * How many separate threads this row stands for. He started a fresh thread
   * for each GitHub follow-up rather than replying, so one dead address
   * produced seven identical rows until they were collapsed.
   */
  collapsedThreads?: number;
}

/** Silence before a nudge is worth suggesting. */
export const NUDGE_AFTER_DAYS = 7;
/** Silence before a nudge has clearly not worked. */
export const ESCALATE_AFTER_DAYS = 21;

export interface ThreadOverlay {
  /** threadKey -> ISO timestamp. Explicitly closed by the owner. */
  closed: Record<string, string>;
  /** threadKey -> ISO timestamp. Manually tracked despite no heuristic match. */
  tracked: Record<string, string>;
  /** threadKey -> ISO date. Muted until then. */
  snoozed: Record<string, string>;
}

export const EMPTY_THREAD_OVERLAY: ThreadOverlay = { closed: {}, tracked: {}, snoozed: {} };

function daysBetween(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000));
}

/**
 * The counterparty is whoever is not him. On an outbound message that is the
 * recipient; on an inbound one it is the sender.
 */
function counterpartyOf(msgs: { outbound: boolean; from: string; to: string[] }[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const who = m.outbound ? m.to[0] : m.from;
    if (who) return who;
  }
  return 'unknown';
}

export interface BuildThreadsOptions {
  now?: Date;
  overlay?: ThreadOverlay;
  /** address -> number of bounce notices seen for it. */
  deadAddresses?: Map<string, number>;
}

export function buildThreads(results: TriageResult[], opts: BuildThreadsOptions = {}): FollowUpThread[] {
  const now = opts.now ?? new Date();
  const overlay = opts.overlay ?? EMPTY_THREAD_OVERLAY;
  const dead = opts.deadAddresses ?? new Map<string, number>();

  // A thread is tracked if a deterministic rule opened a loop on any of its
  // messages, or if the owner asked for it by hand.
  const groups = new Map<string, TriageResult[]>();
  for (const r of results) {
    // Bounce notices belong to the conversation they report on, but they are
    // machine mail and must not count as either side speaking.
    if (r.classification.category === 'bounce') continue;
    const key = r.signal.threadKey ?? r.signal.externalId;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const threads: FollowUpThread[] = [];

  for (const [threadKey, group] of groups) {
    const opensLoop = group.some((r) => r.opensLoop);
    const manual = Boolean(overlay.tracked[threadKey]);
    if (!opensLoop && !manual) continue;

    const sorted = [...group].sort((a, b) => (a.signal.occurredAt < b.signal.occurredAt ? -1 : 1));
    const messages: ThreadMessage[] = sorted.map((r) => ({
      signalId: r.signal.externalId,
      at: r.signal.occurredAt,
      outbound: r.signal.labels.includes('SENT'),
      subject: r.signal.title,
    }));

    const addressed = sorted.map((r) => ({
      outbound: r.signal.labels.includes('SENT'),
      from: r.signal.senderAddr,
      to: r.signal.toAddrs,
    }));
    const counterparty = counterpartyOf(addressed);

    const outbound = messages.filter((m) => m.outbound);
    const inbound = messages.filter((m) => !m.outbound);
    const lastOutboundAt = outbound.at(-1)?.at;
    const lastInboundAt = inbound.at(-1)?.at;
    const lastActivityAt = messages.at(-1)!.at;

    // Reply-close: if they spoke after he did, the wait is over and the ball
    // is back with him. No model is needed to know who spoke last.
    const direction: Direction =
      lastInboundAt && (!lastOutboundAt || lastInboundAt > lastOutboundAt)
        ? 'i_owe_reply'
        : 'waiting_on_them';

    const ticketId = sorted
      .flatMap((r) => r.extractions)
      .find((e) => e.kind === 'ticket_id' && e.valueText && /^\d{3,}$/.test(e.valueText))?.valueText;

    const daysSilent = daysBetween(lastActivityAt, now);
    const bounces = dead.get(counterparty) ?? 0;

    let state: ThreadState;
    if (overlay.closed[threadKey]) {
      state = 'closed';
    } else if (bounces > 0) {
      // No amount of waiting fixes an address that rejects mail, so a dead
      // channel outranks every timer.
      state = 'dead_channel';
    } else if (overlay.snoozed[threadKey] && overlay.snoozed[threadKey] > now.toISOString().slice(0, 10)) {
      state = 'open';
    } else if (direction === 'i_owe_reply') {
      // The wait is his own. Timers are for the other party's silence.
      state = 'open';
    } else if (daysSilent >= ESCALATE_AFTER_DAYS) {
      state = 'escalate';
    } else if (daysSilent >= NUDGE_AFTER_DAYS) {
      state = 'nudge_due';
    } else {
      state = 'open';
    }

    threads.push({
      threadKey,
      counterparty,
      subject: messages.at(-1)!.subject,
      ticketId,
      direction,
      state,
      messages,
      outboundCount: outbound.length,
      lastActivityAt,
      lastOutboundAt,
      lastInboundAt,
      daysSilent,
      dead: bounces
        ? {
            address: counterparty,
            bounces,
            resendsAfterFirstBounce: outbound.length,
          }
        : undefined,
    });
  }

  return threads.sort(byUrgency);
}

const STATE_RANK: Record<ThreadState, number> = {
  dead_channel: 0,
  escalate: 1,
  nudge_due: 2,
  open: 3,
  closed: 4,
};

function byUrgency(a: FollowUpThread, b: FollowUpThread): number {
  const d = STATE_RANK[a.state] - STATE_RANK[b.state];
  return d !== 0 ? d : b.daysSilent - a.daysSilent;
}
