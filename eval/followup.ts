/**
 * Week-5 demo: the Follow-Up Desk.
 *
 *   node eval/followup.ts          open loops, worst first
 *   node eval/followup.ts --all    including the ones not asking for anything
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeEmail, type RawEmail } from '../packages/core/src/signal.ts';
import { triage } from '../packages/core/src/triage.ts';
import { buildFollowUpView, describeThread, describeDeadChannel } from '../packages/module-followup/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const path = [join(here, 'fixtures/inbox-sample.json'), join(here, 'fixtures/example.sample.json')].find(
  (p) => existsSync(p),
);
if (!path) {
  console.error('no fixtures found');
  process.exit(1);
}
const raw = JSON.parse(readFileSync(path, 'utf8'));
const now = new Date(`${raw.capturedAt ?? '2026-08-24'}T01:30:00Z`);
const messages: RawEmail[] = raw.messages;

const results = messages.map((m) => triage(normalizeEmail(m)));
const view = buildFollowUpView(results, { now, cap: 5 });

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

console.log('');
console.log(C.bold('  FOLLOW-UP DESK'));
console.log(
  C.dim(
    `  ${view.threads.length} tracked · ${view.counts.dead} dead · ${view.counts.escalate} escalate · ` +
      `${view.counts.nudgeDue} nudge · ${view.counts.open} open`,
  ),
);

if (view.deadChannels.length) {
  console.log('');
  console.log(C.bold('  DEAD CHANNELS'));
  for (const c of view.deadChannels) {
    console.log(`  ${C.red('!')} ${describeDeadChannel(c)}`);
    console.log(
      C.dim(
        `      ${c.bounces} delivery failures between ${c.firstBounceAt.slice(0, 10)} and ${c.lastBounceAt.slice(0, 10)}`,
      ),
    );
  }
}

console.log('');
console.log(C.bold(`  ASKING FOR SOMETHING${view.actionable.length ? '' : ' — nothing'}`));
for (const t of view.actionable) {
  const mark =
    t.state === 'dead_channel' ? C.red('dead ') : t.state === 'escalate' ? C.red('esc  ') : C.yellow('nudge');
  console.log(`  ${mark} ${describeThread(t)}`);
  console.log(C.dim(`        ${t.subject.slice(0, 70)}${t.ticketId ? `   #${t.ticketId}` : ''}`));
}

if (view.owedByMe.length) {
  console.log('');
  console.log(C.bold('  YOU OWE A REPLY'));
  for (const t of view.owedByMe.slice(0, 6)) {
    console.log(`    ${t.counterparty.padEnd(34)} ${C.dim(`replied ${t.daysSilent}d ago`)}`);
  }
}

if (process.argv.includes('--all')) {
  console.log('');
  console.log(C.bold('  EVERYTHING TRACKED'));
  for (const t of view.threads) {
    console.log(
      `    ${t.state.padEnd(13)} ${t.counterparty.padEnd(34)} ${String(t.daysSilent).padStart(4)}d  ` +
        C.dim(`${t.messages.length} msg${t.messages.length === 1 ? '' : 's'}`),
    );
  }
}

console.log('');
console.log(
  C.dim(
    '  Nothing here used a model. Who spoke last, how long ago, whether a ticket\n' +
      '  number is present and whether the address bounced are all queries.',
  ),
);
console.log('');
