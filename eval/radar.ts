/**
 * Week-6 demo: Deadline Radar and the trust metrics.
 *
 *   node eval/radar.ts
 *
 * Everything with a date on it, from every source, on one timeline.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeEmail, type RawEmail } from '../packages/core/src/signal.ts';
import { triage } from '../packages/core/src/triage.ts';
import { loadOwner } from '../packages/core/src/ownership.ts';
import { buildRadar, bucketRadar, countdown, radarLabel } from '../packages/core/src/radar/index.ts';
import { computeMetrics, renderMetrics } from '../packages/core/src/metrics.ts';
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
const messages: RawEmail[] = raw.messages;
const results = messages.map((m) => triage(normalizeEmail(m)));

const ledger = buildMoneyView(results, { now, ownedCardLast4: loadOwner().cardLast4 });
const radar = buildRadar(results, {
  now,
  horizonDays: 30,
  obligations: ledger.entries.map((e) => ({
    id: e.id,
    label: e.label,
    kind: e.kind,
    dueDate: e.dueDate,
    amount: e.amount,
    currency: e.currency,
    signalId: e.evidence[0],
  })),
  claimedSignalIds: ledger.entries.flatMap((e) => e.evidence),
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

const buckets = bucketRadar(radar);

console.log('');
console.log(C.bold('  DEADLINE RADAR') + C.dim(`   ${radar.length} dated commitments in the next 30 days`));

const section = (title: string, items: typeof radar, colour: (s: string) => string) => {
  if (!items.length) return;
  console.log('');
  console.log(colour(`  ${title}`));
  for (const i of items) {
    const amt = typeof i.amount === 'number' ? `  ${inr.format(i.amount)}` : '';
    console.log(`    ${countdown(i.daysUntil, now, i.date).padStart(11)}  ${radarLabel(i).slice(0, 56)}${amt}`);
    console.log(
      C.dim(
        `                 ${i.date}${i.opensAt ? ` (window opened ${i.opensAt})` : ''} · ${i.source}` +
          `${i.explicit ? '' : ' · inferred'}`,
      ),
    );
  }
};

section('OVERDUE', buckets.overdue, C.red);
section('TODAY', buckets.today, C.red);
section('THIS WEEK', buckets.thisWeek, C.yellow);
section('LATER', buckets.later, C.dim);

if (!radar.length) console.log(C.green('\n    nothing dated in the next 30 days'));

const gold = messages
  .filter((m: RawEmail & { expect?: { category?: string; urgency?: string } }) => m.expect)
  .map((m: RawEmail & { expect?: { category?: string; urgency?: string } }) => ({
    id: m.id,
    category: m.expect!.category,
    urgency: m.expect!.urgency,
  }));

console.log('');
console.log(C.bold('  TRUST METRICS'));
console.log(renderMetrics(computeMetrics(results, { gold, now, state: { lastSyncAt: now.toISOString(), lastSyncOk: true } })));
console.log('');
