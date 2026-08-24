import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, rmSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));
const RAW = join(DATA_DIR, 'raw-events.jsonl');
const BACKUP = `${RAW}.testbak`;

test('one unreadable line costs one message, not the whole corpus', async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  const had = existsSync(RAW);
  if (had) renameSync(RAW, BACKUP);

  try {
    const good = (id: string) =>
      JSON.stringify({ dedupKey: id, fetchedAt: '2026-08-24T00:00:00Z', payload: { id, sender: 'a@b.com', date: '2026-08-24T00:00:00Z' } });
    // A truncated final line is exactly what an interrupted poll leaves behind.
    writeFileSync(RAW, `${good('a')}\n{"dedupKey":"b","payl\n${good('c')}\n`);

    const { loadRawEventsSafe } = await import(`./store.ts?bust=${Date.now()}`);
    const { events, corrupt } = loadRawEventsSafe();
    assert.equal(events.length, 2, 'the two intact records still load');
    assert.deepEqual(corrupt, [2], 'and the bad line is reported, not hidden');
  } finally {
    rmSync(RAW, { force: true });
    if (had) renameSync(BACKUP, RAW);
  }
});
