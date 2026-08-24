import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redact, rehydrate, luhnValid, verhoeffValid } from './redact.ts';

/**
 * Redaction is the one layer where a miss is a privacy failure rather than a
 * wrong label, so these tests are written adversarially: half of them exist to
 * prove the redactor does NOT fire on things that merely look like secrets.
 */

test('luhn accepts a real card and rejects a lookalike', () => {
  assert.equal(luhnValid('4242424242424242'), true);
  assert.equal(luhnValid('5555555555554444'), true);
  assert.equal(luhnValid('1234567890123456'), false);
  assert.equal(luhnValid('42424242'), false); // too short to be a card
});

test('verhoeff accepts a valid aadhaar and rejects any twelve digits', () => {
  // Brute-force a valid checksum so the fixture is real rather than guessed.
  const base = '99999999999';
  const valid = [...Array(10).keys()].map((d) => base + d).find(verhoeffValid);
  assert.ok(valid, 'expected some check digit to validate');
  assert.equal(verhoeffValid(valid!), true);
  assert.equal(verhoeffValid('123456789012'), false);
  assert.equal(verhoeffValid('12345'), false);
});

test('a one-time code blocks the whole message', () => {
  const r = redact('Hi, your OTP is 481920. Do not share it with anyone.');
  assert.equal(r.blocked, true);
  assert.equal(r.text, '');
  assert.match(r.blockedReason!, /one-time code/);
});

test('recovery and verification codes block too', () => {
  for (const s of [
    '7595166642 is your Instagram recovery code',
    'Your verification code is 8842',
    "Here's your one-time-use support code.",
  ]) {
    assert.equal(redact(s).blocked, true, s);
  }
});

test('card numbers are masked to their tail', () => {
  const r = redact('Method card 4242 4242 4242 4242 Paid On 23 Aug');
  assert.equal(r.blocked, false);
  assert.match(r.text, /<CARD_\*{4}4242>/);
  assert.doesNotMatch(r.text, /4242 4242 4242/);
});

test('a digit run that fails Luhn is left alone', () => {
  const s = 'Reference 1234567890123456 for your records';
  assert.equal(redact(s).text, s);
});

test('the Indian tax ID is removed entirely', () => {
  // It doubles as his statement password, so no partial value may survive.
  const r = redact('To access it, use your PAN ABCDE1234F (in uppercase).');
  assert.match(r.text, /<TAXID>/);
  assert.doesNotMatch(r.text, /ABCDE1234F/);
});

test('account numbers become stable opaque tokens', () => {
  const a = redact('Credited to a/c 123456789012345');
  const b = redact('Debited from a/c 123456789012345');
  const tokenA = a.text.match(/<ACCT_[0-9a-f]{8}>/)?.[0];
  const tokenB = b.text.match(/<ACCT_[0-9a-f]{8}>/)?.[0];
  assert.ok(tokenA, 'expected an account token');
  // Stable across messages so a model can still correlate the same account…
  assert.equal(tokenA, tokenB);
  // …but the digits themselves are gone.
  assert.doesNotMatch(a.text, /123456789012345/);
});

test('money, dates and masked tails survive untouched', () => {
  // If redaction ate these the classifier would lose exactly the fields the
  // product depends on.
  const s =
    'HDFC Biz Grow XXXX 5609 Amount Due ₹7,036.00 Pending Due Date 9th Sep 2026. ' +
    'Rs.361.00 spent on 24-08-26. Total ₹21,373.98 across 3 bills.';
  const r = redact(s);
  assert.equal(r.blocked, false);
  assert.match(r.text, /₹7,036\.00/);
  assert.match(r.text, /9th Sep 2026/);
  assert.match(r.text, /XXXX 5609/);
  assert.match(r.text, /Rs\.361\.00/);
  assert.match(r.text, /24-08-26/);
  assert.match(r.text, /₹21,373\.98/);
});

test('email local parts are masked but domains survive', () => {
  // The sending domain is the strongest classification signal in the product;
  // losing it would blind the model to who is writing.
  const r = redact('Write to support@github.com or nodalofficer@airindia.com');
  assert.match(r.text, /@github\.com/);
  assert.match(r.text, /@airindia\.com/);
  assert.doesNotMatch(r.text, /support@/);
  assert.doesNotMatch(r.text, /nodalofficer@/);
});

test('rehydrate restores every redacted value', () => {
  const original = 'Card 4242 4242 4242 4242 for a/c 123456789012345, call 9876543210';
  const r = redact(original);
  assert.notEqual(r.text, original);
  assert.equal(rehydrate(r.text, r.redactions), original);
});

test('an ordinary marketing email is passed through unchanged', () => {
  const s = 'Unlock ₹1 Lakh in minutes with Flipkart EMI! Check now >> unsubscribe';
  assert.equal(redact(s).text, s);
});
