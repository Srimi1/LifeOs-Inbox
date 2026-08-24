/**
 * Week-2 demo: render the daily brief from real captured mail.
 *
 *   node eval/brief.ts               print the text brief
 *   node eval/brief.ts --html        also write eval/_out/brief.html
 *   node eval/brief.ts --now=ISO     pretend it is a different moment
 *
 * `now` defaults to 07:00 IST on the fixture capture date, so the output is
 * reproducible rather than drifting a day older every time it runs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeEmail, type RawEmail } from '../packages/core/src/signal.ts';
import { triage } from '../packages/core/src/triage.ts';
import { buildBriefFacts } from '../packages/core/src/brief/facts.ts';
import { renderText, renderHtml, renderSubject } from '../packages/core/src/brief/render.ts';
import { readState } from '../packages/core/src/store.ts';
import { buildFollowUpView, briefSection } from '../packages/module-followup/src/index.ts';
import { buildMoneyView } from '../packages/module-money/src/index.ts';
import { loadOwner } from '../packages/core/src/ownership.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = [
  join(here, 'fixtures/inbox-sample.json'),
  join(here, 'fixtures/example.sample.json'),
].find((p) => existsSync(p));

if (!fixturePath) {
  console.error('No fixture file found in eval/fixtures/.');
  process.exit(1);
}

const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
const messages: RawEmail[] = raw.messages;

const nowArg = process.argv.find((a) => a.startsWith('--now='))?.slice(6);
const now = nowArg
  ? new Date(nowArg)
  : new Date(`${raw.capturedAt ?? new Date().toISOString().slice(0, 10)}T01:30:00Z`); // 07:00 IST

const results = messages.map((m) => triage(normalizeEmail(m)));

const state = readState();
// The Follow-Up Desk supplies its own section; core never imports the module.
const desk = briefSection(buildFollowUpView(results, { now, cap: 5 }));
const ledger = buildMoneyView(results, { now, ownedCardLast4: loadOwner().cardLast4 });

const facts = buildBriefFacts(results, {
  now,
  waitingOn: desk.waitingOn,
  deadChannels: desk.deadChannels,
  bills: ledger.bills
    .filter((b) => b.dueDate && b.status !== 'paid')
    .map((b) => ({
      label: b.label,
      cardLast4: b.cardLast4,
      amount: b.amount,
      dueDate: b.dueDate!,
      daysUntil: b.daysUntil ?? 0,
      signalId: b.evidence[0],
    })),
  // With no real sync yet, borrow the capture time so the demo does not shout
  // a staleness alarm about a mailbox that was read minutes ago.
  state: state.lastSyncAt ? state : { lastSyncAt: now.toISOString(), lastSyncOk: true },
});

console.log('');
console.log(`Subject: ${renderSubject(facts)}`);
console.log('─'.repeat(72));
console.log(renderText(facts));
console.log('');

if (process.argv.includes('--html')) {
  const outDir = join(here, '_out');
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'brief.html');
  writeFileSync(path, renderHtml(facts));
  console.log(`HTML written to ${path}`);
  console.log('');
}
