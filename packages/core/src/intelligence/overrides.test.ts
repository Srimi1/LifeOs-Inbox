import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  subjectShape,
  proposeRule,
  promotedRulesAsRulepack,
  findOverride,
  correctionRate,
  PROMOTION_THRESHOLD,
  type Correction,
} from './overrides.ts';
import { normalizeEmail } from '../signal.ts';
import { runRulepack } from '../rulepack/index.ts';
import { SEED_RULES } from '../rulepack/seed.ts';

const sig = (over: Partial<Parameters<typeof normalizeEmail>[0]> = {}) =>
  normalizeEmail({
    id: 'm1',
    sender: 'alerts@example.com',
    subject: 'Statement for account 4471 is ready',
    snippet: 'body text',
    date: '2026-08-24T00:00:00Z',
    labelIds: ['INBOX'],
    ...over,
  });

const correction = (over: Partial<Correction> = {}): Correction => ({
  senderAddr: 'alerts@example.com',
  senderDomain: 'example.com',
  subjectShape: subjectShape('Statement for account 4471 is ready'),
  category: 'bill',
  urgency: 'this_week',
  action: 'pay',
  signalId: 'm1',
  correctedAt: '2026-08-24T00:00:00Z',
  ...over,
});

test('subject shape masks the parts that vary across a series', () => {
  const a = subjectShape('[Srimi1/Experiment] Run failed: metrics - main (13c99d9)');
  const b = subjectShape('[Srimi1/Experiment] Run failed: metrics - main (a71ff02)');
  assert.equal(a, b);
  assert.notEqual(a, subjectShape('[Srimi1/Experiment] Run failed: other - main (13c99d9)'));
});

test('two identical corrections are a coincidence, three are a pattern', () => {
  const two = [correction({ signalId: 'a' }), correction({ signalId: 'b' })];
  assert.equal(proposeRule('alerts@example.com', two), undefined);

  const three = [...two, correction({ signalId: 'c' })];
  const rule = proposeRule('alerts@example.com', three);
  assert.ok(rule, 'expected a proposal at the threshold');
  assert.equal(rule!.category, 'bill');
  assert.equal(rule!.fromCorrections, PROMOTION_THRESHOLD);
});

test('inconsistent corrections never promote', () => {
  // Changing his mind must not harden into a rule.
  const mixed = [
    correction({ signalId: 'a', category: 'bill' }),
    correction({ signalId: 'b', category: 'promo' }),
    correction({ signalId: 'c', category: 'bill' }),
  ];
  assert.equal(proposeRule('alerts@example.com', mixed), undefined);
});

test('a promoted rule outranks every seed rule', () => {
  // The sender is one the seed pack already claims as promotional.
  const s = sig({ sender: 'information@mailers.hdfcbank.bank.in', subject: 'Loan offer' });
  assert.equal(runRulepack(s, SEED_RULES).classification.category, 'promo');

  const promoted = promotedRulesAsRulepack([
    {
      id: 'promoted.test',
      senderAddr: 'information@mailers.hdfcbank.bank.in',
      category: 'bill',
      urgency: 'today',
      action: 'pay',
      fromCorrections: 3,
      promotedAt: '2026-08-24T00:00:00Z',
      enabled: true,
    },
  ]);

  const hit = runRulepack(s, [...promoted, ...SEED_RULES]);
  assert.equal(hit.classification.category, 'bill');
  assert.equal(hit.classification.urgency, 'today');
  assert.equal(hit.rule?.id, 'promoted.test');
  assert.equal(hit.classification.skipLlm, true, 'a promoted sender never reaches a model again');
});

test('a disabled rule stops applying', () => {
  const rules = promotedRulesAsRulepack([
    {
      id: 'promoted.off',
      senderAddr: 'alerts@example.com',
      category: 'bill',
      fromCorrections: 3,
      promotedAt: '2026-08-24T00:00:00Z',
      enabled: false,
    },
  ]);
  assert.equal(rules.length, 0);
});

test('an override matches the rest of a repeating series, not just one message', () => {
  const corrections = [correction({ signalId: 'm1' })];

  // The exact message it was made on.
  assert.ok(findOverride(sig({ id: 'm1' }), corrections));

  // A later message in the same series — different number, same shape.
  const later = sig({ id: 'm9', subject: 'Statement for account 9912 is ready' });
  assert.ok(findOverride(later, corrections), 'expected the shape to match');

  // A genuinely different subject from the same sender must not inherit it.
  const other = sig({ id: 'm7', subject: 'Your card was blocked' });
  assert.equal(findOverride(other, corrections), undefined);
});

test('the latest correction wins when the owner changes their mind', () => {
  const corrections = [
    correction({ signalId: 'm1', category: 'bill', correctedAt: '2026-08-01T00:00:00Z' }),
    correction({ signalId: 'm1', category: 'promo', correctedAt: '2026-08-20T00:00:00Z' }),
  ];
  assert.equal(findOverride(sig({ id: 'm1' }), corrections)!.category, 'promo');
});

test('correction rate is corrections over model-classified items', () => {
  const now = Date.now();
  const recent = [
    correction({ correctedAt: new Date(now - 86_400_000).toISOString() }),
    correction({ correctedAt: new Date(now - 2 * 86_400_000).toISOString() }),
  ];
  const stale = correction({ correctedAt: new Date(now - 40 * 86_400_000).toISOString() });

  const r = correctionRate(40, 7, [...recent, stale]);
  assert.equal(r.corrections, 2, 'the 40-day-old correction is outside the window');
  assert.equal(r.rate, 0.05);
  assert.equal(correctionRate(0, 7, recent).rate, 0, 'no classified items means no rate, not a divide by zero');
});
