/**
 * LifeOS worker CLI.
 *
 *   npm run auth      one-time Google consent
 *   npm run backfill  pull the last 30 days
 *   npm run poll      incremental sync every 5 minutes
 *   npm run triage    classify everything stored and print the summary
 */
import { runConsentFlow, loadTokens } from './gmail/auth.ts';
import { getProfile, getMessage, listMessageIds, listHistorySince } from './gmail/api.ts';
import {
  appendRawEvents,
  loadRawEvents,
  loadDedupKeys,
  readState,
  writeState,
} from '../../../packages/core/src/store.ts';
import { normalizeEmail } from '../../../packages/core/src/signal.ts';
import { triage } from '../../../packages/core/src/triage.ts';
import { buildBriefFacts } from '../../../packages/core/src/brief/facts.ts';
import {
  renderText,
  renderHtml,
  renderSubject,
} from '../../../packages/core/src/brief/render.ts';
import { deliver } from './notify.ts';
import { classifySignal } from '../../../packages/core/src/intelligence/classify.ts';
import { resolveMode, cassetteCount } from '../../../packages/core/src/intelligence/client.ts';
import {
  recordCorrection,
  acceptRule,
  revokeRule,
  loadPromotedRules,
  loadCorrections,
  correctionRate,
} from '../../../packages/core/src/intelligence/overrides.ts';
import { CATEGORIES, URGENCIES, ACTIONS } from '../../../packages/core/src/taxonomy.ts';
import { loadOwner } from '../../../packages/core/src/ownership.ts';
import { buildMoneyView, markPaid, decide, whichCard, loadOverlay } from '../../../packages/module-money/src/index.ts';
import type { Category, Urgency, Action } from '../../../packages/core/src/taxonomy.ts';

const BACKFILL_DAYS = 30;
const POLL_MS = 5 * 60 * 1000;

function log(msg: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)}  ${msg}`);
}

/** Fetch full messages with a small concurrency cap, tolerating individual failures. */
async function fetchAll(ids: string[]): Promise<Awaited<ReturnType<typeof getMessage>>[]> {
  const out: Awaited<ReturnType<typeof getMessage>>[] = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(getMessage));
    for (const r of settled) {
      if (r.status === 'fulfilled') out.push(r.value);
      else log(`  skipped one message: ${r.reason}`);
    }
    if (i && i % 120 === 0) log(`  fetched ${i}/${ids.length}…`);
  }
  return out;
}

async function cmdAuth(): Promise<void> {
  await runConsentFlow();
  const profile = await getProfile();
  writeState({ email: profile.emailAddress, historyId: profile.historyId });
  log(`connected as ${profile.emailAddress}`);
  log('refresh token stored in .tokens.json (gitignored, mode 600)');
  log('next: npm run backfill');
}

async function cmdBackfill(): Promise<void> {
  const since = new Date(Date.now() - BACKFILL_DAYS * 86_400_000);
  const q = `after:${since.toISOString().slice(0, 10).replace(/-/g, '/')}`;
  log(`backfilling ${BACKFILL_DAYS} days (${q})`);

  const ids = await listMessageIds(q, 3000);
  log(`${ids.length} messages to fetch`);

  const seen = loadDedupKeys();
  const fresh = ids.filter((id) => !seen.has(id));
  log(`${fresh.length} not already stored`);

  const msgs = await fetchAll(fresh);
  const added = appendRawEvents(msgs, seen);

  const profile = await getProfile();
  writeState({
    historyId: profile.historyId,
    backfilledThrough: new Date().toISOString(),
    lastSyncAt: new Date().toISOString(),
    lastSyncOk: true,
  });
  log(`stored ${added} new raw events`);
  log('next: npm run triage');
}

async function syncOnce(): Promise<number> {
  const state = readState();
  if (!state.historyId) {
    log('no cursor yet — run backfill first');
    return 0;
  }

  const page = await listHistorySince(state.historyId);
  let ids = page.messageIds;

  if (page.expired) {
    // The cursor aged out. Re-scan a short window instead of the whole mailbox;
    // dedup makes the overlap free.
    log('history cursor expired — re-scanning last 3 days');
    const since = new Date(Date.now() - 3 * 86_400_000);
    ids = await listMessageIds(`after:${since.toISOString().slice(0, 10).replace(/-/g, '/')}`, 500);
  }

  const seen = loadDedupKeys();
  const fresh = ids.filter((id) => !seen.has(id));
  if (!fresh.length) {
    writeState({ lastSyncAt: new Date().toISOString(), lastSyncOk: true, lastError: undefined });
    return 0;
  }

  const msgs = await fetchAll(fresh);
  const added = appendRawEvents(msgs, seen);
  const profile = await getProfile();
  writeState({
    historyId: page.historyId ?? profile.historyId,
    lastSyncAt: new Date().toISOString(),
    lastSyncOk: true,
    lastError: undefined,
  });
  return added;
}

async function cmdPoll(): Promise<void> {
  log(`polling every ${POLL_MS / 60000} minutes — ctrl-c to stop`);
  for (;;) {
    try {
      const n = await syncOnce();
      log(n ? `+${n} new` : 'no change');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // A silently stale dashboard is the fastest possible trust-killer, so
      // sync failure is recorded rather than swallowed.
      writeState({ lastSyncOk: false, lastError: message, lastSyncAt: new Date().toISOString() });
      log(`SYNC FAILED: ${message}`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function cmdTriage(): void {
  const events = loadRawEvents();
  if (!events.length) {
    log('nothing stored yet — run backfill first');
    return;
  }

  const results = events.map((e) => triage(normalizeEmail(e.payload)));
  const resolved = results.filter((r) => r.classification.skipLlm);
  const byCat = new Map<string, number>();
  for (const r of results) {
    byCat.set(r.classification.category, (byCat.get(r.classification.category) ?? 0) + 1);
  }

  console.log('');
  console.log(`  ${results.length} signals · ${((resolved.length / results.length) * 100).toFixed(1)}% resolved at Tier 0`);
  console.log('');
  for (const [cat, n] of [...byCat.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${cat.padEnd(12)} ${String(n).padStart(4)}`);
  }

  const obligations = results.filter((r) => r.obligation);
  const loops = results.filter((r) => r.opensLoop);
  const foreign = results.filter((r) => r.notYours);
  const unconfirmed = results.filter((r) => r.needsCardConfirmation);
  const quarantined = results.filter((r) => r.quarantine);

  console.log('');
  console.log(`    obligations found   ${obligations.length}`);
  console.log(`    loops opened        ${loops.length}`);
  console.log(`    not yours           ${foreign.length}`);
  console.log(`    cards to confirm    ${unconfirmed.length}`);
  console.log(`    parser quarantine   ${quarantined.length}`);

  const state = readState();
  if (state.lastSyncAt) {
    const age = Math.round((Date.now() - Date.parse(state.lastSyncAt)) / 60000);
    console.log('');
    console.log(`    last sync ${age}m ago${state.lastSyncOk === false ? `  FAILED: ${state.lastError}` : ''}`);
  }
  console.log('');
}

/**
 * Assemble and send the daily brief.
 *
 * `--dry` prints without delivering. Note the brief is generated even when
 * sync is stale or broken: it then leads with a [LifeOS ALERT] and says the
 * contents may be out of date. Suppressing it on failure would be the worst
 * option available — silence reads exactly like a quiet day.
 */
async function cmdBrief(dry: boolean): Promise<void> {
  const events = loadRawEvents();
  if (!events.length) {
    log('nothing stored yet — run backfill first');
    return;
  }

  const state = readState();
  const results = events.map((e) => triage(normalizeEmail(e.payload)));
  const facts = buildBriefFacts(results, { state });

  const subject = renderSubject(facts);
  const text = renderText(facts);

  if (dry) {
    console.log(`\nSubject: ${subject}\n${'-'.repeat(72)}`);
    console.log(text);
    console.log('');
    return;
  }

  const to = process.env.BRIEF_TO ?? state.email;
  if (!to) {
    log('no recipient — set BRIEF_TO in .env, or run auth first');
    return;
  }

  const result = await deliver({ to, subject, text, html: renderHtml(facts) });
  if (!result.ok) {
    log(`delivery FAILED via ${result.via}: ${result.error}`);
    process.exitCode = 1;
    return;
  }
  log(
    result.via === 'resend'
      ? `brief sent to ${to} (${result.id})`
      : `no RESEND_API_KEY — brief written to ${result.path}`,
  );
}


/** Everything the pipeline could not resolve, newest first. */
async function cmdReview(): Promise<void> {
  const events = loadRawEvents();
  if (!events.length) return log('nothing stored yet — run backfill first');

  const mode = resolveMode();
  const results = await Promise.all(
    events.map((e) => classifySignal(normalizeEmail(e.payload), { mode })),
  );
  const pending = results
    .filter((r) => r.classification.action === 'needs_review' || r.classification.confidence === 'low')
    .sort((a, b) => (a.signal.occurredAt < b.signal.occurredAt ? 1 : -1));

  console.log('');
  console.log(`  ${pending.length} of ${results.length} need review   (mode=${mode}, ${cassetteCount()} cassettes)`);
  console.log('');
  for (const r of pending.slice(0, 25)) {
    console.log(`  ${r.signal.externalId}  ${r.signal.senderAddr}`);
    console.log(`    ${r.signal.title.slice(0, 72)}`);
    console.log(`    guessed ${r.classification.category}/${r.classification.urgency} · ${r.classification.ruleIds.slice(-1)[0] ?? 'no rule'}`);
  }
  console.log('');
  console.log('  fix one:  npm run correct -- <signalId> <category> [urgency] [action]');
  console.log('');
}

/**
 * Record a correction. It takes effect before any model call from now on, and
 * after three consistent corrections for a sender it offers to become a rule —
 * at which point that sender never reaches a model again.
 */
async function cmdCorrect(args: string[]): Promise<void> {
  const [signalId, category, urgency, action] = args;
  if (!signalId || !category) {
    return log(`usage: correct <signalId> <${CATEGORIES.join('|')}> [urgency] [action]`);
  }
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    return log(`unknown category ${category} — one of: ${CATEGORIES.join(' ')}`);
  }
  if (urgency && !(URGENCIES as readonly string[]).includes(urgency)) {
    return log(`unknown urgency ${urgency} — one of: ${URGENCIES.join(' ')}`);
  }
  if (action && !(ACTIONS as readonly string[]).includes(action)) {
    return log(`unknown action ${action} — one of: ${ACTIONS.join(' ')}`);
  }

  const event = loadRawEvents().find((e) => e.dedupKey === signalId);
  if (!event) return log(`no stored signal with id ${signalId}`);

  const sig = normalizeEmail(event.payload);
  const before = await classifySignal(sig, { mode: resolveMode(), audit: false });

  const { proposal } = recordCorrection(
    sig,
    { category: category as Category, urgency: urgency as Urgency, action: action as Action },
    {
      category: before.classification.category,
      urgency: before.classification.urgency,
      action: before.classification.action,
      method: before.classification.method,
    },
  );

  log(`${before.classification.category} -> ${category} for ${sig.senderAddr}`);
  log('this correction now outranks every future model run for that message');

  if (proposal) {
    console.log('');
    console.log(`  Three consistent corrections for ${proposal.senderAddr}.`);
    console.log(`  Promote to a rule?  npm run accept -- ${proposal.senderAddr}`);
    console.log(`  That sender would then be classified ${proposal.category} deterministically, with no model call.`);
    console.log('');
  }
}

function cmdRules(): void {
  const rules = loadPromotedRules();
  const corrections = loadCorrections();
  console.log('');
  if (!rules.length) console.log('  no promoted rules yet');
  for (const r of rules) {
    console.log(`  ${r.enabled ? 'on ' : 'off'}  ${r.senderAddr.padEnd(38)} -> ${r.category}`);
    console.log(`       from ${r.fromCorrections} corrections on ${r.promotedAt.slice(0, 10)}`);
  }
  const bySender = new Map<string, number>();
  for (const c of corrections) bySender.set(c.senderAddr, (bySender.get(c.senderAddr) ?? 0) + 1);
  const pending = [...bySender.entries()]
    .filter(([s, n]) => n >= 2 && !rules.some((r) => r.senderAddr === s))
    .sort((a, b) => b[1] - a[1]);
  if (pending.length) {
    console.log('');
    console.log('  building toward a rule:');
    for (const [sender, n] of pending.slice(0, 8)) console.log(`    ${sender}  ${n} corrections`);
  }
  console.log('');
}


const inr = new Intl.NumberFormat('en-IN', {
  style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2,
});

/** Every bill and renewal owed, worst first, with the canary underneath. */
function cmdMoney(): void {
  const events = loadRawEvents();
  if (!events.length) return log('nothing stored yet — run backfill first');

  const results = events.map((e) => triage(normalizeEmail(e.payload)));
  const view = buildMoneyView(results, { overlay: loadOverlay(), ownedCardLast4: loadOwner().cardLast4 });

  console.log('');
  if (!view.bills.length) console.log('  no bills found');
  for (const b of view.bills) {
    const flag = b.status === 'overdue' ? '!' : b.status === 'due_soon' ? '•' : b.status === 'paid' ? '✓' : ' ';
    const when = b.dueDate
      ? (b.daysUntil ?? 0) < 0 ? `${-(b.daysUntil ?? 0)}d overdue` : `in ${b.daysUntil}d`
      : 'amount in PDF';
    console.log(
      `  ${flag} ${b.label.padEnd(34)}${b.cardLast4 ? ` ····${b.cardLast4}` : '        '}` +
      `  ${(typeof b.amount === 'number' ? inr.format(b.amount) : '—').padStart(12)}  ${when}`,
    );
    if (b.conflict) console.log(`      conflict on ${b.conflict.field}: ${b.conflict.values.join(' vs ')}`);
    console.log(`      ${b.id}`);
  }
  if (view.bills.length) console.log(`\n  ${inr.format(view.total)} outstanding`);

  if (view.atRisk.length) {
    console.log('\n  AT RISK');
    for (const r of view.atRisk) console.log(`  ! ${r.label.padEnd(24)} ${r.serviceStatus}`);
  }

  if (view.inferred.length) {
    console.log('\n  RECURRING');
    for (const i of view.inferred) {
      console.log(`    ${i.label.slice(0, 30).padEnd(30)} ${inr.format(i.amount)} ${i.cadence} · next ${i.nextExpected}`);
    }
  }

  console.log('\n  CANARY');
  if (!view.alerts.length) console.log('    quiet — every known card is billing on schedule');
  for (const a of view.alerts) {
    console.log(`    ${a.severity === 'alert' ? 'ALERT' : 'warn '} ${a.title}`);
  }
  const blind = view.alerts.some((a) => a.kind === 'source_silent' || a.kind === 'missing_bill');
  if (blind) console.log('\n  The total above is not trustworthy while the canary is firing.');
  console.log('');
}

const cmd = process.argv[2];
try {
  if (cmd === 'auth') await cmdAuth();
  else if (cmd === 'backfill') await cmdBackfill();
  else if (cmd === 'poll') await cmdPoll();
  else if (cmd === 'triage') cmdTriage();
  else if (cmd === 'brief') await cmdBrief(process.argv.includes('--dry'));
  else if (cmd === 'review') await cmdReview();
  else if (cmd === 'correct') await cmdCorrect(process.argv.slice(3));
  else if (cmd === 'rules') cmdRules();
  else if (cmd === 'money') cmdMoney();
  else if (cmd === 'paid') {
    const id = process.argv[3];
    if (!id) log('usage: paid <obligationId>   (ids are shown by `npm run money`)');
    else { markPaid(id); log(`marked ${id} paid — it stays on the ledger as history`); }
  }
  else if (cmd === 'keep' || cmd === 'cancel') {
    const who = process.argv[3];
    if (!who) log(`usage: ${cmd} <counterparty>`);
    else { decide(who, cmd as 'keep' | 'cancel'); log(`${who}: ${cmd}`); }
  }
  else if (cmd === 'card') {
    const q = process.argv.slice(3).join(' ');
    const a = whichCard(q);
    console.log('');
    console.log(a.card ? `  ${a.card.label} ····${a.card.last4}` : '  no card');
    console.log(`  ${a.because}`);
    console.log('');
  }
  else if (cmd === 'accept') {
    const sender = process.argv[3];
    const proposal = sender ? loadPromotedRules().find((r) => r.senderAddr === sender) : undefined;
    const { proposeRule } = await import('../../../packages/core/src/intelligence/overrides.ts');
    const fresh = sender ? proposeRule(sender) : undefined;
    if (!sender) log('usage: accept <senderAddr>');
    else if (proposal) log(`${sender} already has a rule`);
    else if (!fresh) log(`${sender} does not have ${3} consistent corrections yet`);
    else {
      acceptRule(fresh);
      log(`promoted: ${sender} -> ${fresh.category}. That sender no longer reaches a model.`);
    }
  }
  else if (cmd === 'revoke') {
    const sender = process.argv[3];
    if (!sender) log('usage: revoke <senderAddr>');
    else { revokeRule(sender); log(`revoked the rule for ${sender}`); }
  }
  else if (cmd === 'status') {
    console.log(JSON.stringify({ ...readState(), connected: Boolean(loadTokens()) }, null, 2));
  } else {
    console.log(
      'usage: auth | backfill | poll | triage | brief [--dry] | review |\n' +
      '       correct <id> <category> [urgency] [action] | rules | accept <sender> | revoke <sender> |\n' +
      '       money | paid <id> | keep <who> | cancel <who> | card <category> | status',
    );
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
