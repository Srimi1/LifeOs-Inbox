import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferRecurring, type Charge } from './renewals.ts';
import { runCanary } from './canary.ts';
import { buildLedger, obligationId, totalOutstanding, EMPTY_OVERLAY } from './ledger.ts';
import { whichCard, type CardTable } from './cards.ts';
import type { TriageResult } from '../../core/src/triage.ts';
import type { ObligationDraft } from '../../core/src/obligation.ts';
import { normalizeEmail } from '../../core/src/signal.ts';

const charge = (merchant: string, amount: number, at: string, id: string): Charge => ({
  merchant,
  merchantKey: merchant.toLowerCase().replace(/\s+/g, '-'),
  amount,
  at,
  signalId: id,
});

// ---------------------------------------------------------------- renewals

test('a steady monthly charge is a subscription', () => {
  const found = inferRecurring([
    charge('Vercel', 2000, '2026-06-01T00:00:00Z', 'a'),
    charge('Vercel', 2000, '2026-07-01T00:00:00Z', 'b'),
    charge('Vercel', 2000, '2026-08-01T00:00:00Z', 'c'),
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].cadence, 'monthly');
  assert.equal(found[0].amount, 2000);
  assert.equal(found[0].nextExpected, '2026-08-31');
});

test('gift-card purchases are NOT a subscription', () => {
  // The real shape from his Razorpay receipts: same merchant, wildly different
  // amounts, several on the same day. A naive same-merchant rule would invent
  // a monthly bill here and put a fictional obligation in front of him.
  const found = inferRecurring([
    charge('MAXIMIZE PAY SOLUTIONS PRIVATE LIMITED', 975, '2026-08-18T17:22:34Z', 'a'),
    charge('MAXIMIZE PAY SOLUTIONS PRIVATE LIMITED', 150, '2026-08-18T17:24:35Z', 'b'),
    charge('MAXIMIZE PAY SOLUTIONS PRIVATE LIMITED', 150, '2026-08-18T17:37:38Z', 'c'),
    charge('MAXIMIZE PAY SOLUTIONS PRIVATE LIMITED', 488.75, '2026-08-22T10:50:21Z', 'd'),
    charge('MAXIMIZE PAY SOLUTIONS PRIVATE LIMITED', 300, '2026-08-23T06:26:58Z', 'e'),
  ]);
  assert.deepEqual(found, []);
});

test('a regular cadence with drifting amounts is rejected', () => {
  const found = inferRecurring([
    charge('Shop', 100, '2026-06-01T00:00:00Z', 'a'),
    charge('Shop', 400, '2026-07-01T00:00:00Z', 'b'),
    charge('Shop', 250, '2026-08-01T00:00:00Z', 'c'),
  ]);
  assert.deepEqual(found, [], 'a subscription bills the same number');
});

test('a stable amount at irregular intervals is rejected', () => {
  const found = inferRecurring([
    charge('Shop', 200, '2026-06-01T00:00:00Z', 'a'),
    charge('Shop', 200, '2026-06-03T00:00:00Z', 'b'),
    charge('Shop', 200, '2026-08-01T00:00:00Z', 'c'),
  ]);
  assert.deepEqual(found, [], 'the average gap fits monthly but the individual gaps do not');
});

test('two charges are never enough', () => {
  const found = inferRecurring([
    charge('Vercel', 2000, '2026-07-01T00:00:00Z', 'a'),
    charge('Vercel', 2000, '2026-08-01T00:00:00Z', 'b'),
  ]);
  assert.deepEqual(found, []);
});

// ------------------------------------------------------------------ canary

const billEntry = (last4: string, label: string, evidenceId: string) => ({
  id: obligationId({ kind: 'bill' as const, counterparty: label, dueDate: '2026-09-09' }),
  kind: 'bill' as const,
  counterparty: label,
  label,
  currency: 'INR',
  dueDate: '2026-09-09',
  cardLast4: last4,
  status: 'upcoming' as const,
  evidence: [evidenceId],
  sources: ['savesage@1'],
});

test('the canary stays quiet while bills keep arriving', () => {
  const alerts = runCanary({
    entries: [billEntry('5609', 'HDFC Biz Grow', 's1')],
    knownCards: [{ last4: '5609' }],
    receivedAt: new Map([['s1', '2026-08-16T00:00:00Z']]),
    now: new Date('2026-08-24T00:00:00Z'),
    expectedSources: ['savesage@1'],
  });
  assert.deepEqual(alerts, []);
});

test('kill the bill mail and the canary fires', () => {
  // The demo: same card, but the statement that should have arrived did not.
  const alerts = runCanary({
    entries: [billEntry('5609', 'HDFC Biz Grow', 's1')],
    knownCards: [{ last4: '5609' }],
    receivedAt: new Map([['s1', '2026-06-16T00:00:00Z']]),
    now: new Date('2026-08-24T00:00:00Z'),
    expectedSources: [],
  });
  const missing = alerts.find((a) => a.kind === 'missing_bill');
  assert.ok(missing, 'expected a missing-bill alert');
  assert.match(missing!.title, /no bill in 69 days/);
  assert.equal(missing!.severity, 'alert');
});

test('a card that never bills is surfaced, not ignored', () => {
  const alerts = runCanary({
    entries: [],
    knownCards: [{ last4: '6268' }],
    receivedAt: new Map(),
    now: new Date('2026-08-24T00:00:00Z'),
    expectedSources: [],
  });
  assert.equal(alerts[0].kind, 'never_billed');
  assert.match(alerts[0].title, /6268/);
});

test('losing the whole aggregator is one alert, not a slow drip', () => {
  const alerts = runCanary({
    entries: [],
    knownCards: [],
    receivedAt: new Map(),
    now: new Date('2026-08-24T00:00:00Z'),
    expectedSources: ['savesage@1'],
  });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'source_silent');
});

// ------------------------------------------------------------------ ledger

const draftResult = (d: ObligationDraft): TriageResult =>
  ({
    signal: normalizeEmail({
      id: d.evidence[0],
      sender: 'x@example.com',
      subject: 'bill',
      date: '2026-08-16T00:00:00Z',
      labelIds: ['INBOX'],
    }),
    classification: {
      category: 'bill',
      urgency: 'this_week',
      action: 'pay',
      confidence: 'high',
      method: 'rule',
      classifierVersion: 'test',
      ruleIds: [],
      skipLlm: true,
    },
    extractions: [],
    obligation: d,
    opensLoop: false,
  }) as TriageResult;

const bill = (over: Partial<ObligationDraft> = {}): ObligationDraft => ({
  kind: 'bill',
  counterparty: 'icici-amazon-pay',
  counterpartyLabel: 'ICICI Amazon Pay',
  amount: 9463.95,
  currency: 'INR',
  dueDate: '2026-08-30',
  cardLast4: '9005',
  evidence: ['sig-a'],
  sourceParser: 'savesage@1',
  ...over,
});

test('the same bill from two sources is one row with two sources', () => {
  const entries = buildLedger(
    [
      draftResult(bill()),
      draftResult(bill({ evidence: ['sig-b'], sourceParser: 'issuer-fallback@1' })),
    ],
    { now: new Date('2026-08-24T00:00:00Z') },
  );
  assert.equal(entries.length, 1, 'expected one merged obligation');
  assert.deepEqual(entries[0].evidence.sort(), ['sig-a', 'sig-b']);
  assert.equal(entries[0].sources.length, 2);
  assert.equal(entries[0].conflict, undefined);
});

test('disagreeing sources surface a conflict and the issuer wins', () => {
  const entries = buildLedger(
    [
      draftResult(bill({ amount: 9463.95, sourceParser: 'savesage@1' })),
      draftResult(bill({ amount: 9500, evidence: ['sig-b'], sourceParser: 'issuer-fallback@1' })),
    ],
    { now: new Date('2026-08-24T00:00:00Z') },
  );
  assert.equal(entries.length, 1);
  assert.ok(entries[0].conflict, 'expected the disagreement to be recorded');
  assert.equal(entries[0].conflict!.field, 'amount');
  // The issuer is authoritative about its own bill.
  assert.equal(entries[0].amount, 9500);
});

test('worst first: suspended, then overdue, then soonest due', () => {
  const entries = buildLedger(
    [
      draftResult(bill({ counterparty: 'far', counterpartyLabel: 'Far', dueDate: '2026-09-20', evidence: ['f'] })),
      draftResult(bill({ counterparty: 'late', counterpartyLabel: 'Late', dueDate: '2026-08-01', evidence: ['l'] })),
      draftResult(
        bill({
          kind: 'renewal',
          counterparty: 'aws',
          counterpartyLabel: 'AWS',
          dueDate: undefined,
          serviceStatus: 'suspended',
          evidence: ['s'],
        }),
      ),
    ],
    { now: new Date('2026-08-24T00:00:00Z') },
  );
  assert.deepEqual(entries.map((e) => e.label), ['AWS', 'Late', 'Far']);
  assert.equal(entries[1].status, 'overdue');
});

test('marking paid removes it from the outstanding total but keeps the row', () => {
  const results = [draftResult(bill())];
  const id = obligationId({ kind: 'bill', counterparty: 'icici-amazon-pay', dueDate: '2026-08-30' });

  const open = buildLedger(results, { now: new Date('2026-08-24T00:00:00Z') });
  assert.equal(Math.round(totalOutstanding(open)), 9464);

  const paid = buildLedger(results, {
    now: new Date('2026-08-24T00:00:00Z'),
    overlay: { ...EMPTY_OVERLAY, paid: { [id]: '2026-08-24T00:00:00Z' } },
  });
  assert.equal(paid[0].status, 'paid');
  assert.equal(totalOutstanding(paid), 0);
  assert.equal(paid.length, 1, 'the row stays — history is not deleted');
});

// ------------------------------------------------------------------- cards

const table: CardTable = {
  cards: [{ last4: '9005', label: 'ICICI Amazon Pay' }],
  rules: [{ category: 'amazon', cardLast4: '9005', note: '5% back on Amazon' }],
};

test('which card is a lookup in his own table', () => {
  const a = whichCard('amazon', table);
  assert.equal(a.card?.label, 'ICICI Amazon Pay');
  assert.equal(a.because, '5% back on Amazon');
});

test('no rule means no answer, not a guess', () => {
  const a = whichCard('fuel', table);
  assert.equal(a.card, undefined);
  assert.match(a.because, /no rule for "fuel"/);
});
