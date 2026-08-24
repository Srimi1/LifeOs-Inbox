/**
 * Week-3 demo: a correction that sticks, and then stops costing anything.
 *
 *   node eval/correction-demo.ts
 *
 * Runs entirely in memory against the real fixtures — it writes nothing to
 * data/, so it can be run repeatedly without polluting the correction history.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeEmail, type RawEmail } from '../packages/core/src/signal.ts';
import { runRulepack } from '../packages/core/src/rulepack/index.ts';
import { SEED_RULES } from '../packages/core/src/rulepack/seed.ts';
import {
  subjectShape,
  proposeRule,
  promotedRulesAsRulepack,
  findOverride,
  PROMOTION_THRESHOLD,
  type Correction,
} from '../packages/core/src/intelligence/overrides.ts';

const here = dirname(fileURLToPath(import.meta.url));
const path = [join(here, 'fixtures/inbox-sample.json'), join(here, 'fixtures/example.sample.json')].find(
  (p) => existsSync(p),
);
if (!path) {
  console.error('no fixtures found');
  process.exit(1);
}
const messages: RawEmail[] = JSON.parse(readFileSync(path, 'utf8')).messages;

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

// A sender the seed pack currently files as promotional. Suppose he disagrees:
// these SmartEMI notices quote a real outstanding balance and he wants them
// treated as money, not marketing.
const SENDER = 'information@mailers.hdfcbank.bank.in';
const series = messages.filter((m) => m.sender === SENDER).slice(0, 4);
const signals = series.map(normalizeEmail);

console.log('');
console.log(bold('  The correction loop'));
console.log(dim(`  ${SENDER} — ${series.length} messages in this series`));
console.log('');

const before = runRulepack(signals[0], SEED_RULES);
console.log(`  ${dim('now')}        ${before.classification.category}   ${dim(`via ${before.rule?.id}`)}`);
console.log(`  ${dim('he says')}    bill`);
console.log('');

const corrections: Correction[] = [];
for (let i = 0; i < signals.length; i++) {
  const sig = signals[i];
  corrections.push({
    senderAddr: sig.senderAddr,
    senderDomain: sig.senderDomain,
    subjectShape: subjectShape(sig.title),
    category: 'bill',
    urgency: 'this_week',
    action: 'pay',
    signalId: sig.externalId,
    correctedAt: new Date(Date.now() - (signals.length - i) * 3600_000).toISOString(),
  });

  const proposal = proposeRule(SENDER, corrections);
  const n = corrections.length;
  console.log(
    `  correction ${n}   ${
      proposal
        ? green(`pattern — offering to promote to a rule`)
        : dim(`${PROMOTION_THRESHOLD - n} more before this becomes a rule`)
    }`,
  );

  // Even before promotion, the correction already binds the rest of the series.
  if (n === 1) {
    const later = signals[signals.length - 1];
    const hit = findOverride(later, corrections);
    console.log(
      `               ${dim('and it already applies to')} ${
        hit ? green('later messages in the series') : yellow('only that one message')
      }`,
    );
  }
}

const proposal = proposeRule(SENDER, corrections)!;
console.log('');
console.log(bold('  After accepting the rule'));

const withRule = runRulepack(signals[0], [...promotedRulesAsRulepack([proposal]), ...SEED_RULES]);
console.log(`  category    ${green(withRule.classification.category)}   ${dim(`via ${withRule.rule?.id}`)}`);
console.log(`  urgency     ${withRule.classification.urgency}`);
console.log(
  `  model call  ${withRule.classification.skipLlm ? green('never again for this sender') : yellow('still needed')}`,
);
console.log('');
console.log(
  dim(
    '  The pipeline gets more deterministic the more it is corrected — cost and\n' +
      '  error surface both shrink with use rather than growing.',
  ),
);
console.log('');
