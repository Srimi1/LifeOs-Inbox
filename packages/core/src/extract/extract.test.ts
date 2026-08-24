import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCardTails } from './identifiers.ts';
import { extractDates, primaryDueDate } from './date.ts';

const NOW = new Date('2026-08-24T00:00:00Z');

/**
 * Regressions from an external review. Each of these was reproduced against
 * the shipped code before the fix, and each is reachable from ordinary mail.
 */

test('a long run of mask characters cannot hang the extractor', () => {
  // The original pattern nested two unbounded quantifiers, so a run of x's
  // backtracked exponentially: 36 characters took 13ms, 40 took over twenty
  // seconds. Marketing mail is full of decorative dot and bullet runs, so this
  // is one promotional email away from freezing the poller for good.
  for (const filler of ['x'.repeat(4000), '•'.repeat(4000), '·'.repeat(2000) + '-'.repeat(2000)]) {
    const started = Date.now();
    extractCardTails(`${filler}!`);
    const ms = Date.now() - started;
    assert.ok(ms < 500, `took ${ms}ms on a ${filler.length}-char run`);
  }
});

test('masked card tails still parse in every real shape', () => {
  const shapes: [string, string][] = [
    ['Method card XXXX-XXXX-XXXX-6268 Paid On', '6268'],
    ['HDFC Biz Grow XXXX 5609 Amount Due', '5609'],
    ['Credit Card xx7895: Zero Processing Fee', '7895'],
    ['Millennia ····8842 statement', '8842'],
  ];
  for (const [text, want] of shapes) {
    const got = extractCardTails(text).map((e) => e.valueText);
    assert.ok(got.includes(want), `expected ${want} from ${JSON.stringify(text)}, got ${got.join(',')}`);
  }
});

test('Aadhaar is still never harvested as a card tail', () => {
  assert.deepEqual(extractCardTails('Aadhaar number XXXX XXXX 8563 was used'), []);
});

test('a past labelled due date never beats a real future one', () => {
  // Indian card statements routinely quote the previous cycle's dates. Picking
  // the earliest labelled date reported a bill as already overdue while the
  // real deadline was two weeks away.
  const t = 'Previous statement due date was 25-07-2026. Current payment due date is 15-09-2026';
  assert.equal(primaryDueDate(t, extractDates(t), NOW)?.valueDate, '2026-09-15');
});

test('an all-past labelled date is still returned — genuinely overdue bills exist', () => {
  const t = 'Payment due date was 25-07-2026 and remains unpaid';
  assert.equal(primaryDueDate(t, extractDates(t), NOW)?.valueDate, '2026-07-25');
});

test('an ambiguous numeric date is not silently promoted to THE due date', () => {
  // Policy already said ambiguous dates need corroboration, but the labelled
  // branch never checked the flag: "03-04-26" could be 3 April or 4 March.
  const t = 'Payment due date: 03-04-26';
  const picked = primaryDueDate(t, extractDates(t), NOW);
  assert.notEqual(picked?.valueText, 'ambiguous_dmy');
});

test('an unambiguous labelled date is preferred over an ambiguous one', () => {
  const t = 'Statement date 03-04-26. Payment due date is 15-09-2026.';
  assert.equal(primaryDueDate(t, extractDates(t), NOW)?.valueDate, '2026-09-15');
});
