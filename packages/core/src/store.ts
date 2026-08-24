import { appendFileSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { RawEmail } from './signal.ts';

/**
 * Week-1 storage: append-only JSONL on disk.
 *
 * The shape deliberately mirrors `db/schema.sql` — raw_events is immutable and
 * uniquely keyed, cursors live beside the account, nothing derived is ever
 * written back over its source. Swapping this for Postgres is a driver change,
 * not a redesign, and until a database is actually needed this keeps the whole
 * pipeline runnable with no service to provision and nothing to leave running.
 */
const DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));
const RAW_PATH = join(DATA_DIR, 'raw-events.jsonl');
const STATE_PATH = join(DATA_DIR, 'state.json');

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

export interface RawEvent {
  dedupKey: string;
  fetchedAt: string;
  payload: RawEmail;
}

export interface SyncState {
  email?: string;
  historyId?: string;
  lastSyncAt?: string;
  lastSyncOk?: boolean;
  lastError?: string;
  backfilledThrough?: string;
}

export function readState(): SyncState {
  if (!existsSync(STATE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as SyncState;
  } catch {
    return {};
  }
}

export function writeState(patch: Partial<SyncState>): SyncState {
  ensureDir();
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

export function loadRawEvents(): RawEvent[] {
  if (!existsSync(RAW_PATH)) return [];
  return readFileSync(RAW_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RawEvent);
}

export function loadDedupKeys(): Set<string> {
  return new Set(loadRawEvents().map((e) => e.dedupKey));
}

/**
 * Append only what has not been seen. The unique dedupKey is the idempotency
 * anchor for the whole pipeline: any re-poll, cursor reset or full re-scan
 * collapses into a no-op instead of duplicating a bill.
 */
export function appendRawEvents(emails: RawEmail[], seen = loadDedupKeys()): number {
  ensureDir();
  const fresh = emails.filter((e) => !seen.has(e.id));
  if (!fresh.length) return 0;
  const lines = fresh
    .map((payload) =>
      JSON.stringify({ dedupKey: payload.id, fetchedAt: new Date().toISOString(), payload } satisfies RawEvent),
    )
    .join('\n');
  appendFileSync(RAW_PATH, lines + '\n');
  for (const e of fresh) seen.add(e.id);
  return fresh.length;
}

export { DATA_DIR, RAW_PATH, STATE_PATH };
