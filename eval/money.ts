/**
 * Week-4 demo: the Money Ledger, and the canary.
 *
 *   node eval/money.ts              every bill and renewal, worst first
 *   node eval/money.ts --kill-savesage   drop the aggregator's mail and watch
 *
 * The second mode is the point. It simulates the dependency the plan flagged:
 * SaveSage is a third party and a competitor, and if it stops emitting nothing
 * breaks loudly — the bills simply stop appearing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeEmail, type RawEmail } from '../packages/core/src/signal.ts';
import { triage } from '../packages/core/src/triage.ts';
import { loadOwner } from '../packages/core/src/ownership.ts';
import { buildMoneyView } from '../packages/module-money/src/index.ts';

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

const kill = process.argv.includes('--kill-savesage');
const messages: RawEmail[] = kill
  ? raw.messages.filter((m: RawEmail) => !m.sender.includes('savesage'))
  : raw.messages;

const results = messages.map((m) => triage(normalizeEmail(m)));
const view = buildMoneyView(results, {
  now,
  ownedCardLast4: loadOwner().cardLast4,
});

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const money = (n?: number) => (typeof n === 'number' ? inr.format(n) : '—');

const when = (e: { dueDate?: string; daysUntil?: number }) => {
  if (!e.dueDate) return 'no date';
  const d = e.daysUntil ?? 0;
  if (d < 0) return `${-d}d overdue`;
  if (d === 0) return 'today';
  return `in ${d}d`;
};

console.log('');
console.log(C.bold('  MONEY LEDGER') + C.dim(kill ? '   (SaveSage mail removed)' : ''));
console.log(C.dim(`  ${messages.length} messages · ${view.entries.length} obligations`));
console.log('');

if (view.bills.length) {
  const w = Math.max(...view.bills.map((b) => b.label.length));
  const aw = Math.max(...view.bills.map((b) => money(b.amount).length));
  for (const b of view.bills) {
    const flag =
      b.status === 'overdue' ? C.red('!')
      : b.status === 'due_soon' ? C.yellow('•')
      : b.status === 'predicted' ? C.yellow('?')
      : ' ';
    const tail = b.cardLast4 ? C.dim(` ····${b.cardLast4}`) : '';
    console.log(
      `  ${flag} ${b.label.padEnd(w)}${tail}  ${money(b.amount).padStart(aw)}  ${C.dim(when(b).padEnd(12))}${C.dim(b.sources.join('+'))}`,
    );
    if (b.conflict) {
      console.log(`      ${C.red('conflict')} ${b.conflict.field}: ${b.conflict.values.join(' vs ')}`);
    }
  }
  console.log(`  ${' '.repeat(w + 3)}${C.bold(money(view.total).padStart(aw))}  ${C.dim('outstanding')}`);
} else {
  console.log(C.yellow('  no bills found'));
}

// The whole point of the canary: a low total and a firing canary together mean
// "we cannot see your bills", which looks identical to "you have no bills".
const blind = view.alerts.some((a) => a.kind === 'source_silent' || a.kind === 'missing_bill');
if (blind) {
  console.log('');
  console.log(
    C.red('  This total is not trustworthy right now — see CANARY below.') +
      C.dim('\n  A quiet ledger and a blind one look the same from here.'),
  );
}

if (view.atRisk.length) {
  console.log('');
  console.log(C.bold('  SERVICES AT RISK'));
  for (const r of view.atRisk) {
    console.log(`  ${C.red('!')} ${r.label.padEnd(18)} ${r.serviceStatus}`);
  }
}

if (view.renewals.length) {
  console.log('');
  console.log(C.bold('  RENEWALS'));
  for (const r of view.renewals.slice(0, 8)) {
    console.log(`    ${r.label.padEnd(24)} ${money(r.amount).padStart(11)}  ${C.dim(when(r))}`);
  }
}

console.log('');
console.log(C.bold('  RECURRING CHARGES DETECTED'));
if (view.inferred.length) {
  for (const i of view.inferred) {
    console.log(`    ${i.label.slice(0, 34).padEnd(34)} ${money(i.amount)} ${i.cadence} · next ${i.nextExpected}`);
  }
} else {
  console.log(
    C.dim('    none — the repeated gift-card charges vary in amount and spacing,\n' +
          '    so they are purchases, not a subscription'),
  );
}

console.log('');
console.log(C.bold('  CANARY'));
if (!view.alerts.length) {
  console.log(C.green('    quiet — every known card is billing on schedule'));
} else {
  for (const a of view.alerts) {
    const mark = a.severity === 'alert' ? C.red('ALERT') : C.yellow('warn ');
    console.log(`    ${mark} ${a.title}`);
    console.log(C.dim(`          ${a.detail.replace(/\s+/g, ' ').slice(0, 96)}`));
  }
}
console.log('');
