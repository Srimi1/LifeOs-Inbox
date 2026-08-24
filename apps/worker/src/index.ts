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

const cmd = process.argv[2];
try {
  if (cmd === 'auth') await cmdAuth();
  else if (cmd === 'backfill') await cmdBackfill();
  else if (cmd === 'poll') await cmdPoll();
  else if (cmd === 'triage') cmdTriage();
  else if (cmd === 'brief') await cmdBrief(process.argv.includes('--dry'));
  else if (cmd === 'status') {
    console.log(JSON.stringify({ ...readState(), connected: Boolean(loadTokens()) }, null, 2));
  } else {
    console.log('usage: auth | backfill | poll | triage | brief [--dry] | status');
    process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
