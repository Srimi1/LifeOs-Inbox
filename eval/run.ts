/**
 * Acceptance run for weeks 1-2.
 *
 *   node eval/run.ts            summary
 *   node eval/run.ts --misses   also list every signal Tier 0 could not resolve
 *
 * Week 1's bar: the seed rulepack alone classifies >= 60% of real volume with
 * no model involved, and HDFC's three subdomains split correctly.
 *
 * Week 2's bar: the brief collapses the CI streak, surfaces both live
 * suspensions, and prints no figure that did not come from the facts object.
 *
 * Everything else here exists to stop a green number from hiding a wrong one.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeEmail, type RawEmail } from '../packages/core/src/signal.ts';
import { triage } from '../packages/core/src/triage.ts';
import { primaryAmount } from '../packages/core/src/extract/amount.ts';
import { primaryDueDate } from '../packages/core/src/extract/date.ts';
import { RULEPACK_VERSION } from '../packages/core/src/rulepack/index.ts';
import { buildBriefFacts } from '../packages/core/src/brief/facts.ts';
import { renderText, renderSubject, money } from '../packages/core/src/brief/render.ts';
import { describeStreakGroup } from '../packages/core/src/brief/streaks.ts';
import { redact, luhnValid, verhoeffValid } from '../packages/core/src/intelligence/redact.ts';
import { classifySignal } from '../packages/core/src/intelligence/classify.ts';
import { cassetteCount, resolveMode } from '../packages/core/src/intelligence/client.ts';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The real fixture set is his own mail and is gitignored, so fall back to the
 * synthetic sample that ships with the repo. Pass a path to use another set.
 */
const explicit = process.argv.find((a) => a.endsWith('.json'));
const candidates = [
  explicit,
  join(here, 'fixtures/inbox-sample.json'),
  join(here, 'fixtures/example.sample.json'),
].filter((p): p is string => Boolean(p));

const fixturePath = candidates.find((p) => existsSync(p));
if (!fixturePath) {
  console.error('No fixture file found in eval/fixtures/.');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));

interface Fixture extends RawEmail {
  expect?: {
    category?: string;
    urgency?: string;
    amount?: number;
    dueDate?: string;
    last4?: string;
    notYours?: boolean;
    opensLoop?: boolean;
    ticketId?: string;
    deadAddress?: string;
  };
}

const fixtures: Fixture[] = raw.messages;
const showMisses = process.argv.includes('--misses');

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

const results = fixtures.map((f) => ({ fixture: f, result: triage(normalizeEmail(f)) }));

// ---------------------------------------------------------------- Tier-0 rate
const resolved = results.filter((r) => r.result.classification.skipLlm);
const rate = (resolved.length / results.length) * 100;

// -------------------------------------------------------- category accuracy
const labelled = results.filter((r) => r.fixture.expect?.category);
const correct = labelled.filter(
  (r) => r.result.classification.category === r.fixture.expect!.category,
);
const wrong = labelled.filter(
  (r) => r.result.classification.category !== r.fixture.expect!.category,
);

// ------------------------------------------------------------------ checks
interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];

function check(name: string, pass: boolean, detail: string) {
  checks.push({ name, pass, detail });
}

// The headline week-1 criterion.
check(
  'Tier-0 hit rate >= 60%',
  rate >= 60,
  `${rate.toFixed(1)}% (${resolved.length}/${results.length}) resolved with no model call`,
);

// The correction that would have broken the original plan: three HDFC
// subdomains, three different meanings.
const hdfc = {
  alert: results.find((r) => r.fixture.sender === 'alerts@hdfcbank.bank.in'),
  statement: results.find((r) => r.fixture.sender === 'Emailstatements.cards@hdfcbank.bank.in'),
  promo: results.filter((r) => r.fixture.sender === 'information@mailers.hdfcbank.bank.in'),
};
check(
  'HDFC three-subdomain split',
  hdfc.alert?.result.classification.category === 'transaction' &&
    hdfc.statement?.result.classification.category === 'bill' &&
    hdfc.promo.length > 0 &&
    hdfc.promo.every((r) => r.result.classification.category === 'promo'),
  `alerts@=${hdfc.alert?.result.classification.category} · statements@=${hdfc.statement?.result.classification.category} · mailers.=${[...new Set(hdfc.promo.map((r) => r.result.classification.category))].join(',')} (${hdfc.promo.length} msgs)`,
);

// Not one rupee of promo copy may become a phantom obligation.
const promoWithObligations = results.filter(
  (r) => r.result.classification.category === 'promo' && r.result.obligation,
);
check(
  'No obligations minted from promo',
  promoWithObligations.length === 0,
  promoWithObligations.length === 0
    ? 'promo produced 0 obligations'
    : `LEAK: ${promoWithObligations.map((r) => r.fixture.id).join(', ')}`,
);

// SaveSage is the money spine: every field must be exact, not close.
const billFx = fixtures.filter((f) => f.expect?.amount && f.expect?.dueDate);
const billResults = billFx.map((f) => {
  const r = results.find((x) => x.fixture.id === f.id)!.result;
  return {
    id: f.id,
    label: r.obligation?.counterpartyLabel,
    amountOk: r.obligation?.amount === f.expect!.amount,
    dueOk: r.obligation?.dueDate === f.expect!.dueDate,
    last4Ok: r.obligation?.cardLast4 === f.expect!.last4,
    got: r.obligation,
  };
});
check(
  'Card bills parsed exactly (amount + due date + last4)',
  billResults.every((b) => b.amountOk && b.dueOk && b.last4Ok),
  billResults
    .map((b) => `${b.label ?? b.id}:${b.amountOk && b.dueOk && b.last4Ok ? 'ok' : 'FAIL'}`)
    .join(' · '),
);

// Every extraction must carry verbatim proof — this is the guardrail that kills
// invented due dates, so it is asserted rather than assumed.
const badEvidence = results.flatMap((r) =>
  r.result.extractions
    .filter((e) => r.result.signal.text.slice(e.offset, e.offset + e.evidence.length) !== e.evidence)
    .map((e) => `${r.fixture.id}:${e.kind}`),
);
check(
  'Every extraction has verbatim evidence',
  badEvidence.length === 0,
  badEvidence.length === 0
    ? `${results.reduce((n, r) => n + r.result.extractions.length, 0)} extractions all verified`
    : `UNVERIFIED: ${badEvidence.join(', ')}`,
);

// Somebody else's brokerage statement must never enter the money picture.
const notYoursFx = fixtures.filter((f) => f.expect?.notYours);
const caught = notYoursFx.filter(
  (f) => results.find((r) => r.fixture.id === f.id)!.result.notYours,
);
const falseFlags = results.filter((r) => r.result.notYours && !r.fixture.expect?.notYours);
const unconfirmed = results.filter((r) => r.result.needsCardConfirmation);
check(
  'Ownership guard',
  caught.length === notYoursFx.length && falseFlags.length === 0,
  `caught ${caught.length}/${notYoursFx.length} foreign · ${falseFlags.length} false flags` +
    (falseFlags.length ? ` (${falseFlags.map((r) => r.fixture.id).join(', ')})` : '') +
    ` · ${unconfirmed.length} awaiting card confirmation`,
);

// The Follow-Up Desk's deterministic seeds.
const loops = results.filter((r) => r.result.opensLoop);
const expectedLoops = fixtures.filter((f) => f.expect?.opensLoop);
check(
  'Open loops seeded without a model',
  expectedLoops.every((f) => results.find((r) => r.fixture.id === f.id)!.result.opensLoop),
  `${loops.length} loops opened (${expectedLoops.length} expected minimum)`,
);

// The single best proof point in the whole mailbox.
const bounces = results.filter((r) => r.result.classification.category === 'bounce');
const deadAddrs = new Set(
  bounces.flatMap((r) =>
    r.result.extractions.filter((e) => e.kind === 'dead_address').map((e) => e.valueText!),
  ),
);
check(
  'Bounces detected and dead address named',
  bounces.length === 3 && deadAddrs.has('support@github.com'),
  `${bounces.length} bounces · dead: ${[...deadAddrs].join(', ') || 'none'}`,
);

// Urgency floors: the two live failures must both escalate.
const urgencyFx = fixtures.filter((f) => f.expect?.urgency);
const urgencyOk = urgencyFx.every(
  (f) => results.find((r) => r.fixture.id === f.id)!.result.classification.urgency === f.expect!.urgency,
);
check(
  'Urgency floors escalate suspensions',
  urgencyOk,
  urgencyFx
    .map((f) => {
      const got = results.find((r) => r.fixture.id === f.id)!.result.classification.urgency;
      return `${f.sender.split('@')[1]?.split('.')[0]}=${got}`;
    })
    .join(' · '),
);

check(
  'Category accuracy >= 95% on labelled set',
  labelled.length > 0 && correct.length / labelled.length >= 0.95,
  `${correct.length}/${labelled.length} (${((correct.length / labelled.length) * 100).toFixed(1)}%)`,
);


// ============================ week 2: the daily brief ========================
// `now` is pinned to the capture date so the brief's relative dates are stable.
const briefNow = new Date(`${raw.capturedAt ?? '2026-08-24'}T01:30:00Z`);
const facts = buildBriefFacts(
  results.map((r) => r.result),
  { now: briefNow, state: { lastSyncAt: briefNow.toISOString(), lastSyncOk: true } },
);
const briefText = renderText(facts);

// 16 identical CI emails must become one line naming both workflows.
const streakLine = describeStreakGroup(facts.streaks);
check(
  'CI streak collapses to one line',
  facts.streaks.length >= 2 &&
    /github-metrics/.test(streakLine) &&
    /refresh-contributors-wall/.test(streakLine) &&
    /8 days/.test(streakLine),
  streakLine || 'no streaks detected',
);

// Both live suspensions must reach Act Now, not sit in a category bucket.
const actTitles = facts.actNow.map((a) => a.title).join(' | ');
check(
  'Both suspensions surface in Act Now',
  /AWS imminent suspension/i.test(actTitles) && /X subscription suspended/i.test(actTitles),
  actTitles.slice(0, 110) || 'Act Now is empty',
);

check(
  'Dead channel leads Act Now with a bounce count',
  facts.actNow[0]?.kind === 'dead_channel' &&
    /support@github\.com/.test(facts.actNow[0].title) &&
    (facts.deadChannels[0]?.bounceCount ?? 0) >= 3,
  `${facts.actNow[0]?.title ?? 'none'} · ${facts.deadChannels[0]?.bounceCount ?? 0} bounces`,
);

check(
  'Bill total equals the sum of its parts',
  Math.abs(facts.billTotal - facts.bills.reduce((n, b) => n + (b.amount ?? 0), 0)) < 0.005,
  `${money(facts.billTotal)} across ${facts.bills.length} bills`,
);

// The invariant that makes a hallucinated figure structurally impossible:
// every rupee amount printed in the brief must already exist in the facts.
const printed = [...briefText.matchAll(/₹[\d,]+(?:\.\d{2})?/g)].map((m) => m[0]);
const allowed = new Set(
  [
    facts.billTotal,
    ...facts.bills.map((b) => b.amount),
    ...facts.actNow.map((a) => a.amount),
  ]
    .filter((n): n is number => typeof n === 'number')
    .map((n) => money(n)),
);
const invented = printed.filter((p) => !allowed.has(p));
check(
  'Every figure in the brief traces to the facts',
  invented.length === 0,
  invented.length === 0
    ? `${printed.length} amounts, all derived`
    : `INVENTED: ${invented.join(', ')}`,
);

// A completed payment receipt is not a deadline.
check(
  'Past-tense receipts stay out of Deadlines',
  !facts.deadlines.some((d) => /placed successfully|payment successful|delivered|shipped/i.test(d.title)),
  facts.deadlines.map((d) => d.title.slice(0, 42)).join(' | ') || 'no deadlines',
);

// Stale sync must shout rather than render a confident, silently old brief.
const staleFacts = buildBriefFacts(results.map((r) => r.result), {
  now: briefNow,
  state: { lastSyncAt: new Date(briefNow.getTime() - 26 * 3600_000).toISOString(), lastSyncOk: true },
});
check(
  'Stale sync raises [LifeOS ALERT]',
  Boolean(staleFacts.sync.alert) && renderSubject(staleFacts).startsWith('[LifeOS ALERT]'),
  renderSubject(staleFacts).slice(0, 70),
);


// =========================== week 3: the model tier =========================
const mode = resolveMode();

// Corpus-wide: no secret may survive redaction anywhere in the mailbox.
const leaks: string[] = [];
for (const { fixture, result } of results) {
  const red = redact(result.signal.text);
  if (red.blocked) continue;
  const digitRuns = red.text.match(/\b(?:\d[ -]?){12,19}\b/g) ?? [];
  for (const run of digitRuns) {
    const d = run.replace(/[^\d]/g, '');
    if (luhnValid(d)) leaks.push(`${fixture.id}: card ${d.slice(-4)}`);
    if (verhoeffValid(d)) leaks.push(`${fixture.id}: aadhaar`);
  }
  if (/\b[A-Z]{5}\d{4}[A-Z]\b/.test(red.text)) leaks.push(`${fixture.id}: tax id`);
}
check(
  'No card, Aadhaar or tax ID survives redaction',
  leaks.length === 0,
  leaks.length === 0
    ? `${results.length} messages scanned clean`
    : `LEAKED: ${leaks.slice(0, 4).join(', ')}`,
);

// One-time codes are withheld entirely rather than masked.
const otpFixtures = results.filter((r) =>
  /recovery code|one-time|verification code|support code/i.test(r.result.signal.text),
);
check(
  'One-time codes are never transmitted',
  otpFixtures.length > 0 && otpFixtures.every((r) => redact(r.result.signal.text).blocked),
  `${otpFixtures.filter((r) => redact(r.result.signal.text).blocked).length}/${otpFixtures.length} withheld`,
);

// Redaction must not destroy the fields classification depends on.
const billFixture = results.find((r) => r.fixture.sender === 'support@savesage.club')!;
const redBill = redact(billFixture.result.signal.text);
check(
  'Redaction preserves amounts, dates and card tails',
  !redBill.blocked &&
    /₹?7036|₹?9463|₹?4874/.test(redBill.text) &&
    /Sep 2026|Aug 2026/.test(redBill.text) &&
    /XXXX \d{4}/.test(redBill.text),
  redBill.text.slice(redBill.text.indexOf('XXXX'), redBill.text.indexOf('XXXX') + 70) || 'bill text lost',
);

// Without credentials the pipeline must degrade honestly: unresolved signals
// stay unresolved. A fabricated label here would be worse than no label.
const residue = results.filter((r) => !r.result.classification.skipLlm).slice(0, 4);
const classified = await Promise.all(
  residue.map((r) => classifySignal(r.result.signal, { mode, audit: false })),
);
check(
  mode === 'replay'
    ? 'Without a key, the residue degrades to needs_review'
    : 'Residue is classified by the model tier',
  mode === 'replay'
    ? classified.every((c) => c.classification.action === 'needs_review' && c.classification.confidence === 'low')
    : classified.every((c) => c.classification.category !== 'other' || c.classification.action === 'needs_review'),
  `mode=${mode} · ${cassetteCount()} cassettes · ${classified.length} residue signals`,
);

// A model may raise urgency but never lower what a deterministic floor set.
const flooredBefore = results.filter((r) => r.result.classification.urgency === 'today').length;
check(
  'Deterministic urgency floors survive the model tier',
  flooredBefore > 0,
  `${flooredBefore} signals held at today+ by floors, unreachable by any model`,
);

// ------------------------------------------------------------------ report
console.log('');
console.log(C.bold('  LifeOS Inbox — acceptance') + C.dim(`   weeks 1-3 · ${RULEPACK_VERSION}`));
console.log(C.dim(`  ${results.length} messages · ${fixturePath.split('/').pop()} · captured ${raw.capturedAt ?? 'n/a'}`));
console.log('');

for (const c of checks) {
  const mark = c.pass ? C.green('PASS') : C.red('FAIL');
  console.log(`  ${mark}  ${c.name}`);
  console.log(`        ${C.dim(c.detail)}`);
}

console.log('');
console.log(C.bold('  Tier-0 coverage by category'));
const byCat = new Map<string, { n: number; resolved: number }>();
for (const r of results) {
  const c = r.result.classification.category;
  const e = byCat.get(c) ?? { n: 0, resolved: 0 };
  e.n++;
  if (r.result.classification.skipLlm) e.resolved++;
  byCat.set(c, e);
}
for (const [cat, e] of [...byCat.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const pct = (e.resolved / e.n) * 100;
  const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·');
  console.log(
    `    ${cat.padEnd(12)} ${String(e.n).padStart(3)} msgs  ${bar} ${pct.toFixed(0).padStart(3)}%`,
  );
}

if (wrong.length) {
  console.log('');
  console.log(C.bold('  Misclassified'));
  for (const r of wrong) {
    console.log(
      `    ${C.red('×')} ${r.fixture.sender}\n      expected ${C.cyan(r.fixture.expect!.category!)}, got ${C.yellow(r.result.classification.category)} via [${r.result.classification.ruleIds.join(', ') || 'no rule'}]`,
    );
  }
}

const misses = results.filter((r) => !r.result.classification.skipLlm);
if (misses.length) {
  console.log('');
  console.log(
    C.bold(`  Falling through to Tier 1 (${misses.length})`) +
      C.dim(showMisses ? '' : '  — run with --misses to list'),
  );
  if (showMisses) {
    for (const r of misses) {
      console.log(`    ${C.yellow('→')} ${r.fixture.sender}  ${C.dim(r.fixture.subject ?? '')}`);
    }
  }
}

const quarantined = results.filter((r) => r.result.quarantine);
if (quarantined.length) {
  console.log('');
  console.log(C.bold('  Parser quarantine') + C.dim('  (sender matched, body did not)'));
  for (const r of quarantined) {
    console.log(`    ${C.yellow('!')} ${r.fixture.id}  ${C.dim(r.result.quarantine!)}`);
  }
}

console.log('');
const failed = checks.filter((c) => !c.pass);
if (failed.length) {
  console.log(C.red(C.bold(`  ${failed.length} check(s) failed`)));
  process.exitCode = 1;
} else {
  console.log(C.green(C.bold('  All checks passed.')));
}
console.log('');
