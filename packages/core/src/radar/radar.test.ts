import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWindows, classifyDeadline, datedCandidates } from './windows.ts';
import { buildRadar, countdown, bucketRadar, radarLabel } from './index.ts';
import { normalizeEmail, type RawEmail } from '../signal.ts';
import { triage } from '../triage.ts';

const NOW = new Date('2026-08-24T00:00:00Z');

const sig = (over: Partial<RawEmail> & { id: string }) =>
  normalizeEmail({
    sender: 'noreply@example.com',
    subject: 'Notice',
    date: '2026-08-23T00:00:00Z',
    labelIds: ['INBOX'],
    ...over,
  });

// ------------------------------------------------------------------ windows

test('the closing edge of a window is the deadline, not the opening', () => {
  // Real subject from his mailbox. Taking the first date gives 25 August —
  // when voting *opens*, the least useful of the three dates present.
  const text =
    'e-Voting FOR NHPC LIMITED - EQ will be OPEN FROM 25-08-2026 09:00 TO 27-08-2026 17:00 ' +
    'AND Meeting ON 28-08-2026 11:30';
  const [w] = extractWindows(text);
  assert.ok(w, 'expected a window');
  assert.equal(w.opensAt, '2026-08-25');
  assert.equal(w.closesAt, '2026-08-27', 'the 27th is when the option disappears');
});

test('a hyphen between two non-dates is not a window', () => {
  assert.deepEqual(extractWindows('Order 4168064881 - 205235179 shipped'), []);
  assert.deepEqual(extractWindows('Call +91 9876543210 - ext 4455'), []);
});

test('a backwards range is rejected', () => {
  assert.deepEqual(extractWindows('valid from 27-08-2026 to 25-08-2026'), []);
});

test('deadline kind comes from the words around it', () => {
  assert.equal(classifyDeadline('e-Voting for NHPC LIMITED closes'), 'vote');
  assert.equal(classifyDeadline('Your credit card bill Amount Due 2500'), 'pay');
  assert.equal(classifyDeadline('Your subscription will automatically renew on 2 Sept'), 'decide');
  assert.equal(classifyDeadline('Cohort 3 registration closes'), 'submit');
  assert.equal(classifyDeadline('Nothing dated in here at all'), 'other');
});

// --------------------------------------------------------------- candidates

test('past dates are never deadlines', () => {
  const c = datedCandidates(sig({ id: 'a', snippet: 'Please respond by 1 Jan 2020.' }), NOW);
  assert.deepEqual(c, []);
});

test('an explicitly labelled date outranks an incidental one', () => {
  const c = datedCandidates(
    sig({
      id: 'a',
      snippet: 'Sent 30 Sep 2026 for your records. Last date to apply is 1 Sep 2026.',
    }),
    NOW,
  );
  assert.equal(c[0].date, '2026-09-01');
  assert.equal(c[0].explicit, true);
});

// ------------------------------------------------------------------- radar

test('the e-voting window reaches the radar as a vote closing on the 27th', () => {
  const results = [
    triage(
      sig({
        id: 'v1',
        sender: 'donotreply.evoting@cdslindia.co.in',
        subject:
          'e-Voting FOR NHPC LIMITED - EQ will be OPEN FROM 25-08-2026 09:00 TO 27-08-2026 17:00 AND Meeting ON 28-08-2026 11:30',
        snippet: 'Dear Shareholder, Greetings from CDSL! Reminder for e-Voting of NHPC LIMITED - EQ',
      }),
    ),
  ];
  const radar = buildRadar(results, { now: NOW });
  assert.equal(radar.length, 1);
  assert.equal(radar[0].kind, 'vote');
  assert.equal(radar[0].date, '2026-08-27');
  assert.equal(radar[0].opensAt, '2026-08-25');
  assert.equal(radar[0].daysUntil, 3);
  assert.match(radarLabel(radar[0]), /^Vote:/);
});

test('a message with five dates in it is one row, not five', () => {
  const results = [
    triage(
      sig({
        id: 'm1',
        subject: 'Schedule',
        snippet:
          'Applications open 25 Aug 2026, close 1 Sep 2026, results 10 Sep 2026, ' +
          'induction 15 Sep 2026, term begins 20 Sep 2026. Last date to apply is 1 Sep 2026.',
      }),
    ),
  ];
  const radar = buildRadar(results, { now: NOW });
  assert.equal(radar.length, 1, 'one message is one thing to do');
});

test('ledger obligations and extracted deadlines share one timeline', () => {
  const results = [
    triage(
      sig({
        id: 'v1',
        sender: 'donotreply.evoting@cdslindia.co.in',
        subject: 'e-Voting OPEN FROM 25-08-2026 09:00 TO 27-08-2026 17:00',
        snippet: 'Reminder for e-Voting',
      }),
    ),
  ];
  const radar = buildRadar(results, {
    now: NOW,
    obligations: [
      { id: 'bill_x', label: 'Gamma Shop', kind: 'bill', dueDate: '2026-08-30', amount: 3210.99 },
      { id: 'bill_y', label: 'Gamma Classic', kind: 'bill', dueDate: '2026-08-03', amount: 9876.54 },
    ],
  });
  assert.deepEqual(
    radar.map((i) => i.title),
    ['Gamma Classic', 'e-Voting OPEN FROM 25-08-2026 09:00 TO 27-08-2026 17:00', 'Gamma Shop'],
    'overdue first, then soonest',
  );
  assert.equal(radar[0].daysUntil, -21);
  assert.equal(radar[0].kind, 'pay');
});

test('past-tense categories contribute nothing to the radar', () => {
  const results = [
    triage(
      sig({
        id: 'p1',
        sender: 'no-reply@razorpay.com',
        subject: 'Payment successful for Comet',
        snippet: 'Comet ₹5499.00 Paid Successfully Paid On 30 Aug, 2026',
      }),
    ),
  ];
  assert.deepEqual(buildRadar(results, { now: NOW }), []);
});

// ------------------------------------------------------------- presentation

test('countdown switches to hours inside three days', () => {
  assert.equal(countdown(-3), '3d overdue');
  assert.equal(countdown(0), 'today');
  assert.match(countdown(1, NOW, '2026-08-25'), /^\d+h left$/);
  assert.equal(countdown(9), '9d');
});

test('buckets split by how soon, not by category', () => {
  const b = bucketRadar([
    { daysUntil: -2 } as never,
    { daysUntil: 0 } as never,
    { daysUntil: 3 } as never,
    { daysUntil: 20 } as never,
  ]);
  assert.equal(b.overdue.length, 1);
  assert.equal(b.today.length, 1);
  assert.equal(b.thisWeek.length, 1);
  assert.equal(b.later.length, 1);
});
