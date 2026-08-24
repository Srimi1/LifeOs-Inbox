/**
 * Week-1 acceptance run.
 *
 *   node eval/run.ts            summary
 *   node eval/run.ts --misses   also list every signal Tier 0 could not resolve
 *
 * The bar the plan set for week 1: the seed rulepack alone classifies >= 60% of
 * real volume with no model involved, and HDFC's three subdomains split
 * correctly. Everything else here is there to stop a green number from hiding a
 * wrong one.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeEmail, type RawEmail } from '../packages/core/src/signal.ts';
import { triage } from '../packages/core/src/triage.ts';
import { primaryAmount } from '../packages/core/src/extract/amount.ts';
import { primaryDueDate } from '../packages/core/src/extract/date.ts';
import { RULEPACK_VERSION } from '../packages/core/src/rulepack/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(readFileSync(join(here, 'fixtures/inbox-sample.json'), 'utf8'));

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

// ------------------------------------------------------------------ report
console.log('');
console.log(C.bold('  LifeOS Inbox — Week 1 acceptance') + C.dim(`   ${RULEPACK_VERSION}`));
console.log(C.dim(`  ${results.length} real messages captured ${raw.capturedAt}`));
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
