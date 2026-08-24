import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { TriageResult } from '../../core/src/triage.ts';
import {
  buildThreads,
  EMPTY_THREAD_OVERLAY,
  NUDGE_AFTER_DAYS,
  type FollowUpThread,
  type ThreadOverlay,
} from './threads.ts';
import { findDeadChannels, deadAddressMap, describeDeadChannel, type DeadChannel } from './dead.ts';

export * from './threads.ts';
export * from './dead.ts';

/**
 * Follow-Up Desk.
 *
 * The module owns its own state and reads core signals; core never imports it.
 * Same seam as the Money Ledger — a third module changes nothing in the spine.
 */
const DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));
const OVERLAY_PATH = join(DATA_DIR, 'followup-overlay.json');

export function loadThreadOverlay(): ThreadOverlay {
  if (!existsSync(OVERLAY_PATH)) return EMPTY_THREAD_OVERLAY;
  try {
    const raw = JSON.parse(readFileSync(OVERLAY_PATH, 'utf8')) as Partial<ThreadOverlay>;
    return { closed: raw.closed ?? {}, tracked: raw.tracked ?? {}, snoozed: raw.snoozed ?? {} };
  } catch {
    return EMPTY_THREAD_OVERLAY;
  }
}

export function saveThreadOverlay(o: ThreadOverlay): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(OVERLAY_PATH, JSON.stringify(o, null, 2) + '\n');
}

export function closeThread(threadKey: string): ThreadOverlay {
  const o = loadThreadOverlay();
  o.closed[threadKey] = new Date().toISOString();
  delete o.snoozed[threadKey];
  saveThreadOverlay(o);
  return o;
}

export function trackThread(threadKey: string): ThreadOverlay {
  const o = loadThreadOverlay();
  o.tracked[threadKey] = new Date().toISOString();
  delete o.closed[threadKey];
  saveThreadOverlay(o);
  return o;
}

export function snoozeThread(threadKey: string, untilIsoDate: string): ThreadOverlay {
  const o = loadThreadOverlay();
  o.snoozed[threadKey] = untilIsoDate;
  saveThreadOverlay(o);
  return o;
}

export interface FollowUpView {
  threads: FollowUpThread[];
  /** What the brief shows: the ones actually asking for something. */
  actionable: FollowUpThread[];
  deadChannels: DeadChannel[];
  owedByMe: FollowUpThread[];
  counts: { open: number; nudgeDue: number; escalate: number; dead: number; closed: number };
}

export interface FollowUpOptions {
  now?: Date;
  overlay?: ThreadOverlay;
  /** How many rows the brief is allowed. Nag fatigue kills the whole product. */
  cap?: number;
}

export function buildFollowUpView(results: TriageResult[], opts: FollowUpOptions = {}): FollowUpView {
  const now = opts.now ?? new Date();
  const overlay = opts.overlay ?? EMPTY_THREAD_OVERLAY;
  const cap = opts.cap ?? 5;

  const deadChannels = findDeadChannels(results);
  const threads = buildThreads(results, { now, overlay, deadAddresses: deadAddressMap(deadChannels) });

  const counts = {
    open: threads.filter((t) => t.state === 'open').length,
    nudgeDue: threads.filter((t) => t.state === 'nudge_due').length,
    escalate: threads.filter((t) => t.state === 'escalate').length,
    dead: threads.filter((t) => t.state === 'dead_channel').length,
    closed: threads.filter((t) => t.state === 'closed').length,
  };

  // Only threads that are genuinely asking for something reach the brief, and
  // only a handful of them. A desk that lists everything is a desk that gets
  // skimmed and then ignored.
  //
  // Dead channels collapse by address before that cap is applied. A dead
  // address is one fact however many threads ran into it — and because he
  // opens a new thread per follow-up rather than replying, leaving them
  // separate filled the entire desk with seven copies of the same sentence
  // and pushed the genuinely stale threads off the bottom.
  const asking = threads.filter(
    (t) => t.state === 'dead_channel' || t.state === 'escalate' || t.state === 'nudge_due',
  );
  const seenDead = new Map<string, FollowUpThread>();
  const collapsed: FollowUpThread[] = [];
  for (const t of asking) {
    if (t.state !== 'dead_channel') {
      collapsed.push(t);
      continue;
    }
    const prior = seenDead.get(t.counterparty);
    if (prior) {
      prior.collapsedThreads = (prior.collapsedThreads ?? 1) + 1;
      continue;
    }
    const row = { ...t, collapsedThreads: 1 };
    seenDead.set(t.counterparty, row);
    collapsed.push(row);
  }
  const actionable = collapsed.slice(0, cap);

  return {
    threads,
    actionable,
    deadChannels,
    owedByMe: threads.filter((t) => t.state !== 'closed' && t.direction === 'i_owe_reply'),
    counts,
  };
}

/**
 * One line per thread, phrased as the thing to do rather than the state it is
 * in. "9d silent" is a status; "worth a nudge" is a decision.
 */
export function describeThread(t: FollowUpThread): string {
  if (t.state === 'dead_channel') {
    const n = t.collapsedThreads ?? 1;
    return (
      `${t.counterparty} — mail there bounces, use another route` +
      (n > 1 ? ` (${n} threads)` : '')
    );
  }
  if (t.direction === 'i_owe_reply') {
    return `${t.counterparty} — replied ${t.daysSilent}d ago, you owe an answer`;
  }
  if (t.state === 'escalate') {
    return `${t.counterparty} — ${t.daysSilent}d silent after ${t.outboundCount} message${t.outboundCount === 1 ? '' : 's'}, escalate`;
  }
  if (t.state === 'nudge_due') {
    return `${t.counterparty} — ${t.daysSilent}d silent, worth a nudge`;
  }
  return `${t.counterparty} — ${t.daysSilent}d silent`;
}

/**
 * The module's contribution to the daily brief.
 *
 * Shaped to what core's brief expects, so the desk can replace core's simpler
 * built-in derivation without core knowing this module exists.
 */
export function briefSection(view: FollowUpView): {
  waitingOn: {
    counterparty: string;
    subject: string;
    ticketId?: string;
    direction: 'waiting_on_them' | 'i_owe_reply';
    lastActivityAt: string;
    daysSilent: number;
    pastThreshold: boolean;
    dead: boolean;
  }[];
  deadChannels: { address: string; bounceCount: number; firstAt: string; lastAt: string }[];
} {
  return {
    waitingOn: view.actionable.map((t) => ({
      counterparty: t.counterparty,
      subject: t.subject,
      ticketId: t.ticketId,
      direction: t.direction,
      lastActivityAt: t.lastActivityAt,
      daysSilent: t.daysSilent,
      pastThreshold: t.state === 'nudge_due' || t.state === 'escalate',
      dead: t.state === 'dead_channel',
    })),
    deadChannels: view.deadChannels.map((c) => ({
      address: c.address,
      bounceCount: c.totalSent || c.bounces,
      firstAt: c.firstBounceAt,
      lastAt: c.lastBounceAt,
    })),
  };
}

export { describeDeadChannel, NUDGE_AFTER_DAYS };
