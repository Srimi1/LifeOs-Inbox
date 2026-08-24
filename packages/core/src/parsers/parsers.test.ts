import { test } from 'node:test';
import assert from 'node:assert/strict';
import { savesage, razorpay } from './registry.ts';
import { normalizeEmail } from '../signal.ts';

const sig = (snippet: string, subject = 'Your new credit card bill is ready') =>
  normalizeEmail({
    id: 'm1',
    sender: 'support@savesage.club',
    subject,
    snippet,
    date: '2026-08-16T09:05:07Z',
    labelIds: ['INBOX'],
  });

/**
 * These three templates are all real, all from the same sender, and the first
 * fixture set contained only one of them. Between them they carried two cards
 * and roughly Rs 56,000 of bills the parser never saw.
 */

test('template 1: "bill ready" — the one originally sampled', () => {
  const r = savesage(
    sig(
      'Credit Card Bill Generated Hi Srijan! Your credit card bill has been generated. ' +
        'Please check the details below. HDFC Biz Grow XXXX 5609 Amount Due ₹7036 ' +
        'Pending Due Date 9th Sep 2026 Your 475 pts are',
    ),
  );
  assert.equal(r.quarantine, undefined);
  assert.equal(r.obligation?.amount, 7036);
  assert.equal(r.obligation?.dueDate, '2026-09-09');
  assert.equal(r.obligation?.cardLast4, '5609');
});

test('template 2: "3 days left" reminder, and a date with no ordinal suffix', () => {
  const r = savesage(
    sig(
      '3 Days Left to Pay Your Credit Card Bill Hi Srijan! Your credit card bill is due in 3 days. ' +
        'Pay now to avoid late fees and earn cashback. Axis XXXX 6268 Amount Due ₹15025.84 ' +
        'Pending Due Date 14 Aug 2026 Pay Now',
      'Reminder: Your credit card bill is due in 3 days',
    ),
  );
  assert.equal(r.quarantine, undefined);
  assert.equal(r.obligation?.amount, 15025.84);
  assert.equal(r.obligation?.dueDate, '2026-08-14');
});

test('template 3: "due today" writes the amount with no rupee symbol', () => {
  // The regression that mattered most. This template carries the bill on the
  // day it is due, and requiring a currency symbol made it quarantine silently
  // — Rs 41,037.50 vanished from the ledger on exactly the day it was owed.
  const r = savesage(
    sig(
      'Bill Payment Due Today Hi Srijan! Your credit card bill is due today. ' +
        'Pay now to avoid late fees and earn cashback. ICICI XXXX 4005 Amount Due 41037.5 ' +
        'Pending Due Date 3rd Aug 2026 Pay Now and Earn',
      'Your credit card bill is due today',
    ),
  );
  assert.equal(r.quarantine, undefined, 'must not quarantine');
  assert.equal(r.obligation?.amount, 41037.5);
  assert.equal(r.obligation?.dueDate, '2026-08-03');
  assert.equal(r.obligation?.cardLast4, '4005');
});

test('a card is keyed on its last four, not the label the template used', () => {
  // SaveSage calls the same card "Axis Atlas" in one template and "Axis" in
  // another. Keying on the label split one bill into two and inflated the
  // outstanding total by the full amount of every card that had a reminder.
  const statement = savesage(
    sig('… below. Axis Atlas XXXX 6268 Amount Due ₹15025.84 Pending Due Date 14th Aug 2026 You have'),
  );
  const reminder = savesage(
    sig('… cashback. Axis XXXX 6268 Amount Due ₹15025.84 Pending Due Date 14 Aug 2026 Pay Now'),
  );
  assert.equal(statement.obligation!.counterparty, reminder.obligation!.counterparty);
  assert.equal(statement.obligation!.counterparty, 'card-6268');
  // The labels still differ, so the ledger can pick the more informative one.
  assert.notEqual(statement.obligation!.counterpartyLabel, reminder.obligation!.counterpartyLabel);
});

test('a body the parser cannot read quarantines loudly rather than returning nothing', () => {
  const r = savesage(sig('Hi Srijan! Something completely different happened today.'));
  assert.match(r.quarantine ?? '', /bill block not found/);
  assert.equal(r.obligation, undefined);
});

test('razorpay reads the receipt but mints no obligation', () => {
  const r = razorpay(
    normalizeEmail({
      id: 'r1',
      sender: 'no-reply@razorpay.com',
      subject: 'Payment successful for Comet',
      snippet:
        'Comet ₹5499.00 Paid Successfully Payment Id pay_TPAZluAMoW6q8X Method card ' +
        'XXXX-XXXX-XXXX-6268 Paid On 13 Aug, 2026 12:51:00 PM IST',
      date: '2026-08-13T07:21:16Z',
      labelIds: ['INBOX'],
    }),
  );
  assert.equal(r.extractions.find((e) => e.kind === 'amount')?.valueNum, 5499);
  assert.equal(r.extractions.find((e) => e.kind === 'card_last4')?.valueText, '6268');
  // Money that already moved is not money owed.
  assert.equal(r.obligation, undefined);
});
