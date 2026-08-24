import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildThreads, EMPTY_THREAD_OVERLAY, NUDGE_AFTER_DAYS } from './threads.ts';
import { findDeadChannels, describeDeadChannel } from './dead.ts';
import { buildFollowUpView } from './index.ts';
import { normalizeEmail, type RawEmail } from '../../core/src/signal.ts';
import type { TriageResult } from '../../core/src/triage.ts';
import type { Category } from '../../core/src/taxonomy.ts';

const NOW = new Date('2026-08-24T00:00:00Z');

function result(
  raw: Partial<RawEmail> & { id: string; date: string },
  opts: { category?: Category; opensLoop?: boolean; deadAddress?: string; ticketId?: string } = {},
): TriageResult {
  const signal = normalizeEmail({
    sender: 'support@vendor.com',
    subject: 'Re: your request',
    snippet: 'body',
    labelIds: ['INBOX'],
    ...raw,
  });
  return {
    signal,
    classification: {
      category: opts.category ?? 'support',
      urgency: 'this_week',
      action: 'reply',
      confidence: 'high',
      method: 'rule',
      classifierVersion: 'test',
      ruleIds: [],
      skipLlm: true,
    },
    extractions: [
      ...(opts.deadAddress
        ? [{ kind: 'dead_address' as const, valueText: opts.deadAddress, evidence: opts.deadAddress, offset: 0, method: 'rule' as const, extractorVersion: 't' }]
        : []),
      ...(opts.ticketId
        ? [{ kind: 'ticket_id' as const, valueText: opts.ticketId, evidence: `#${opts.ticketId}`, offset: 0, method: 'rule' as const, extractorVersion: 't' }]
        : []),
    ],
    opensLoop: opts.opensLoop ?? true,
  } as TriageResult;
}

const sent = (id: string, date: string, to: string, threadId: string, subject = 'Follow-up') =>
  result({ id, date, threadId, sender: 'me@gmail.com', toRecipients: [to], subject, labelIds: ['SENT'] });

const inbound = (id: string, date: string, from: string, threadId: string) =>
  result({ id, date, threadId, sender: from, labelIds: ['INBOX'] });

// ------------------------------------------------------------ silence timer

test('a fresh outbound message is open, not a nag', () => {
  const t = buildThreads([sent('a', '2026-08-22T00:00:00Z', 'support@vendor.com', 'T1')], { now: NOW });
  assert.equal(t[0].state, 'open');
  assert.equal(t[0].direction, 'waiting_on_them');
  assert.equal(t[0].daysSilent, 2);
});

test(`silence past ${NUDGE_AFTER_DAYS} days is worth a nudge`, () => {
  const t = buildThreads([sent('a', '2026-08-14T00:00:00Z', 'support@vendor.com', 'T1')], { now: NOW });
  assert.equal(t[0].state, 'nudge_due');
  assert.equal(t[0].daysSilent, 10);
});

test('three weeks of silence escalates', () => {
  const t = buildThreads([sent('a', '2026-07-01T00:00:00Z', 'support@vendor.com', 'T1')], { now: NOW });
  assert.equal(t[0].state, 'escalate');
});

// ------------------------------------------------------------- reply-close

test('a reply flips the thread — the wait is over, the ball is his', () => {
  const t = buildThreads(
    [
      sent('a', '2026-07-01T00:00:00Z', 'support@vendor.com', 'T1'),
      inbound('b', '2026-08-20T00:00:00Z', 'support@vendor.com', 'T1'),
    ],
    { now: NOW },
  );
  assert.equal(t[0].direction, 'i_owe_reply');
  // And it must not be reported as *their* silence, however old the thread is.
  assert.equal(t[0].state, 'open');
});

test('his reply after theirs puts the wait back on them', () => {
  const t = buildThreads(
    [
      inbound('a', '2026-08-01T00:00:00Z', 'support@vendor.com', 'T1'),
      sent('b', '2026-08-02T00:00:00Z', 'support@vendor.com', 'T1'),
    ],
    { now: NOW },
  );
  assert.equal(t[0].direction, 'waiting_on_them');
  assert.equal(t[0].state, 'escalate');
});

test('a five-message escalation is one loop, not five', () => {
  const msgs = [
    sent('a', '2026-07-01T00:00:00Z', 'support@vendor.com', 'T1'),
    inbound('b', '2026-07-02T00:00:00Z', 'support@vendor.com', 'T1'),
    sent('c', '2026-07-03T00:00:00Z', 'support@vendor.com', 'T1'),
    inbound('d', '2026-07-04T00:00:00Z', 'support@vendor.com', 'T1'),
    sent('e', '2026-07-05T00:00:00Z', 'support@vendor.com', 'T1'),
  ];
  const t = buildThreads(msgs, { now: NOW });
  assert.equal(t.length, 1);
  assert.equal(t[0].messages.length, 5);
  assert.equal(t[0].outboundCount, 3);
});

// ------------------------------------------------------------ dead channels

test('bounces aggregate into one dead channel with a resend count', () => {
  const results = [
    sent('s1', '2026-05-19T19:35:32Z', 'support@github.com', 'T1'),
    result({ id: 'b1', date: '2026-05-19T19:35:51Z', threadId: 'T1', sender: 'mailer-daemon@googlemail.com' }, { category: 'bounce', deadAddress: 'support@github.com' }),
    sent('s2', '2026-05-22T03:13:47Z', 'support@github.com', 'T2'),
    result({ id: 'b2', date: '2026-05-22T03:14:07Z', threadId: 'T2', sender: 'mailer-daemon@googlemail.com' }, { category: 'bounce', deadAddress: 'support@github.com' }),
    sent('s3', '2026-05-24T03:30:42Z', 'support@github.com', 'T3'),
  ];
  const [channel] = findDeadChannels(results);
  assert.equal(channel.address, 'support@github.com');
  assert.equal(channel.bounces, 2);
  assert.equal(channel.totalSent, 3);
  // The number that stings: kept writing after the first rejection came back.
  assert.equal(channel.sentAfterFirstBounce, 2);
  assert.match(describeDeadChannel(channel), /3 emails went there and none arrived/);
  assert.match(describeDeadChannel(channel), /2 of them after the first rejection/);
});

test('a dead channel outranks every timer', () => {
  // Two days of silence would normally be "open" — but the address rejects mail,
  // so waiting is not the problem and no amount of it will help.
  const view = buildFollowUpView(
    [
      sent('s1', '2026-08-22T00:00:00Z', 'support@github.com', 'T1'),
      result({ id: 'b1', date: '2026-08-22T00:01:00Z', threadId: 'T1', sender: 'mailer-daemon@googlemail.com' }, { category: 'bounce', deadAddress: 'support@github.com' }),
    ],
    { now: NOW },
  );
  assert.equal(view.threads[0].state, 'dead_channel');
  assert.equal(view.threads[0].dead?.address, 'support@github.com');
  assert.equal(view.actionable[0].state, 'dead_channel');
});

test('bounce notices are not counted as either side speaking', () => {
  const t = buildThreads(
    [
      sent('s1', '2026-07-01T00:00:00Z', 'support@github.com', 'T1'),
      result({ id: 'b1', date: '2026-08-23T00:00:00Z', threadId: 'T1', sender: 'mailer-daemon@googlemail.com' }, { category: 'bounce', deadAddress: 'support@github.com' }),
    ],
    { now: NOW },
  );
  // A robot rejecting the mail yesterday is not the vendor replying yesterday.
  assert.equal(t[0].direction, 'waiting_on_them');
  assert.equal(t[0].daysSilent, 54);
});

// ------------------------------------------------------------------ overlay

test('closing a thread takes it off the desk permanently', () => {
  const msgs = [sent('a', '2026-07-01T00:00:00Z', 'support@vendor.com', 'T1')];
  assert.equal(buildThreads(msgs, { now: NOW })[0].state, 'escalate');

  const closed = buildThreads(msgs, {
    now: NOW,
    overlay: { ...EMPTY_THREAD_OVERLAY, closed: { T1: '2026-08-24T00:00:00Z' } },
  });
  assert.equal(closed[0].state, 'closed');
  assert.equal(buildFollowUpView(msgs, { now: NOW, overlay: { ...EMPTY_THREAD_OVERLAY, closed: { T1: 'x' } } }).actionable.length, 0);
});

test('a thread with no loop rule is ignored unless tracked by hand', () => {
  const msgs = [result({ id: 'a', date: '2026-07-01T00:00:00Z', threadId: 'T9' }, { opensLoop: false })];
  assert.equal(buildThreads(msgs, { now: NOW }).length, 0);

  const tracked = buildThreads(msgs, {
    now: NOW,
    overlay: { ...EMPTY_THREAD_OVERLAY, tracked: { T9: '2026-08-24T00:00:00Z' } },
  });
  assert.equal(tracked.length, 1);
});

test('the desk is capped so it stays readable', () => {
  const many = Array.from({ length: 12 }, (_, i) =>
    sent(`s${i}`, '2026-07-01T00:00:00Z', `support${i}@vendor.com`, `T${i}`),
  );
  const view = buildFollowUpView(many, { now: NOW, cap: 5 });
  assert.equal(view.threads.length, 12, 'all of them are tracked');
  assert.equal(view.actionable.length, 5, 'but only five reach the brief');
  assert.equal(view.counts.escalate, 12);
});

test('ticket ids are carried onto the thread', () => {
  const t = buildThreads(
    [result({ id: 'a', date: '2026-07-01T00:00:00Z', threadId: 'T1' }, { ticketId: '4399615' })],
    { now: NOW },
  );
  assert.equal(t[0].ticketId, '4399615');
});

test('one dead address is one row, however many threads ran into it', () => {
  // He opened a fresh thread for each GitHub follow-up rather than replying,
  // so without collapsing, the desk filled with seven copies of one sentence
  // and pushed the genuinely stale threads off the bottom.
  const msgs = [
    ...Array.from({ length: 7 }, (_, i) =>
      sent(`s${i}`, '2026-05-19T19:35:32Z', 'support@github.com', `T${i}`),
    ),
    result({ id: 'b1', date: '2026-05-19T19:35:51Z', threadId: 'T0', sender: 'mailer-daemon@googlemail.com' }, { category: 'bounce', deadAddress: 'support@github.com' }),
    sent('other', '2026-07-01T00:00:00Z', 'support@vendor.com', 'TX'),
  ];
  const view = buildFollowUpView(msgs, { now: NOW, cap: 5 });

  const deadRows = view.actionable.filter((t) => t.state === 'dead_channel');
  assert.equal(deadRows.length, 1, 'seven threads, one row');
  assert.equal(deadRows[0].collapsedThreads, 7);
  // And the genuinely stale thread is no longer crowded out.
  assert.ok(
    view.actionable.some((t) => t.counterparty === 'support@vendor.com'),
    'the escalated thread must still make the cut',
  );
});
