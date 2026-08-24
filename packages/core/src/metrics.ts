import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { TriageResult } from './triage.ts';
import type { Category } from './taxonomy.ts';
import { isUrgent } from './taxonomy.ts';
import { loadCorrections } from './intelligence/overrides.ts';
import type { SyncState } from './store.ts';

/**
 * The trust dashboard.
 *
 * The plan's north star is the weekly correction rate, and the thresholds are
 * not decoration: above 10% the pipeline is not trustworthy and everything
 * should route through review; under 5% sustained is what earns a category the
 * right to file silently. Autonomy here is earned by measurement, never
 * granted by default.
 *
 * Urgent recall is reported separately from overall accuracy because the two
 * errors are not comparable. A false urgent costs a glance. A missed urgent is
 * how a triage product dies — one bill goes overdue, trust never comes back,
 * and the user returns to reading the raw inbox forever.
 */
const DATA_DIR = fileURLToPath(new URL('../../../data', import.meta.url));
const AUDIT_PATH = join(DATA_DIR, 'ai-audit.jsonl');

export interface TrustMetrics {
  total: number;
  tier0: { resolved: number; rate: number };
  categories: { category: Category; count: number; resolved: number }[];
  quarantined: { count: number; rate: number; reasons: string[] };
  ownership: { notYours: number; needsCardConfirmation: number };
  corrections: { last7d: number; rate: number; verdict: string };
  urgentRecall?: { gold: number; caught: number; rate: number; missed: string[] };
  accuracy?: { gold: number; correct: number; rate: number };
  model: { calls: number; blocked: number; unavailable: number; escalated: number; costUsd: number };
  sync?: { lastSyncAt?: string; ageMinutes?: number; ok: boolean; error?: string };
}

interface AuditRow {
  outcome: string;
  costUsd?: number;
  tier: number;
}

function readAudit(): AuditRow[] {
  if (!existsSync(AUDIT_PATH)) return [];
  return readFileSync(AUDIT_PATH, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as AuditRow];
      } catch {
        return [];
      }
    });
}

/** The plan's thresholds, stated where they are applied. */
export function correctionVerdict(rate: number, sample: number): string {
  if (sample < 20) return 'too few classified items to judge yet';
  if (rate > 0.1) return 'NOT trustworthy — route everything through review';
  if (rate > 0.05) return 'suggestions only — no silent filing';
  if (rate > 0.02) return 'healthy — silent auto-file can be unlocked per category';
  return 'excellent — rules are doing the work';
}

export interface GoldLabel {
  id: string;
  category?: string;
  urgency?: string;
}

export function computeMetrics(
  results: TriageResult[],
  opts: { gold?: GoldLabel[]; state?: SyncState; now?: Date } = {},
): TrustMetrics {
  const now = opts.now ?? new Date();
  const resolved = results.filter((r) => r.classification.skipLlm);

  const byCat = new Map<Category, { count: number; resolved: number }>();
  for (const r of results) {
    const c = r.classification.category;
    const e = byCat.get(c) ?? { count: 0, resolved: 0 };
    e.count++;
    if (r.classification.skipLlm) e.resolved++;
    byCat.set(c, e);
  }

  const quarantined = results.filter((r) => r.quarantine);
  const audit = readAudit();
  const corrections = loadCorrections();
  const cutoff = now.getTime() - 7 * 86_400_000;
  const recent = corrections.filter((c) => Date.parse(c.correctedAt) >= cutoff);

  // The denominator is what a model actually decided. Corrections against
  // deterministic rules are a different signal and would flatter this number.
  const modelClassified = results.filter((r) => r.classification.method === 'llm').length;
  const rate = modelClassified ? recent.length / modelClassified : 0;

  let urgentRecall: TrustMetrics['urgentRecall'];
  let accuracy: TrustMetrics['accuracy'];

  if (opts.gold?.length) {
    const byId = new Map(results.map((r) => [r.signal.externalId, r]));

    const urgentGold = opts.gold.filter((g) => g.urgency && isUrgent(g.urgency as never));
    if (urgentGold.length) {
      const missed = urgentGold.filter((g) => {
        const r = byId.get(g.id);
        return !r || !isUrgent(r.classification.urgency);
      });
      urgentRecall = {
        gold: urgentGold.length,
        caught: urgentGold.length - missed.length,
        rate: (urgentGold.length - missed.length) / urgentGold.length,
        missed: missed.map((g) => g.id),
      };
    }

    const catGold = opts.gold.filter((g) => g.category);
    if (catGold.length) {
      const correct = catGold.filter((g) => byId.get(g.id)?.classification.category === g.category).length;
      accuracy = { gold: catGold.length, correct, rate: correct / catGold.length };
    }
  }

  const syncAge = opts.state?.lastSyncAt
    ? Math.round((now.getTime() - Date.parse(opts.state.lastSyncAt)) / 60_000)
    : undefined;

  return {
    total: results.length,
    tier0: { resolved: resolved.length, rate: results.length ? resolved.length / results.length : 0 },
    categories: [...byCat.entries()]
      .map(([category, e]) => ({ category, ...e }))
      .sort((a, b) => b.count - a.count),
    quarantined: {
      count: quarantined.length,
      rate: results.length ? quarantined.length / results.length : 0,
      reasons: [...new Set(quarantined.map((r) => r.quarantine!))].slice(0, 5),
    },
    ownership: {
      notYours: results.filter((r) => r.notYours).length,
      needsCardConfirmation: results.filter((r) => r.needsCardConfirmation).length,
    },
    corrections: {
      last7d: recent.length,
      rate,
      verdict: correctionVerdict(rate, modelClassified),
    },
    urgentRecall,
    accuracy,
    model: {
      calls: audit.filter((a) => a.tier > 0).length,
      blocked: audit.filter((a) => a.outcome === 'blocked').length,
      unavailable: audit.filter((a) => a.outcome === 'unavailable').length,
      escalated: audit.filter((a) => a.outcome === 'escalated').length,
      costUsd: audit.reduce((n, a) => n + (a.costUsd ?? 0), 0),
    },
    sync: opts.state
      ? {
          lastSyncAt: opts.state.lastSyncAt,
          ageMinutes: syncAge,
          ok: opts.state.lastSyncOk !== false && (syncAge ?? Infinity) < 12 * 60,
          error: opts.state.lastError,
        }
      : undefined,
  };
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function renderMetrics(m: TrustMetrics): string {
  const L: string[] = [];
  L.push(`  ${m.total} signals`);
  L.push('');
  L.push(`  Tier 0 resolved       ${pct(m.tier0.rate).padStart(7)}  ${m.tier0.resolved}/${m.total}, no model call`);

  if (m.accuracy) {
    L.push(`  Category accuracy     ${pct(m.accuracy.rate).padStart(7)}  ${m.accuracy.correct}/${m.accuracy.gold} labelled`);
  }
  if (m.urgentRecall) {
    const flag = m.urgentRecall.rate < 1 ? '  <-- a missed urgent is the product-killing error' : '';
    L.push(
      `  Urgent recall         ${pct(m.urgentRecall.rate).padStart(7)}  ${m.urgentRecall.caught}/${m.urgentRecall.gold}${flag}`,
    );
    if (m.urgentRecall.missed.length) L.push(`      missed: ${m.urgentRecall.missed.join(', ')}`);
  }

  L.push(`  Correction rate (7d)  ${pct(m.corrections.rate).padStart(7)}  ${m.corrections.verdict}`);
  L.push(
    `  Parser quarantine     ${pct(m.quarantined.rate).padStart(7)}  ${m.quarantined.count} message${m.quarantined.count === 1 ? '' : 's'} a parser could not read`,
  );
  for (const r of m.quarantined.reasons) L.push(`      ${r}`);

  if (m.ownership.notYours || m.ownership.needsCardConfirmation) {
    L.push(
      `  Ownership             ${String(m.ownership.notYours).padStart(7)}  excluded as not yours` +
        (m.ownership.needsCardConfirmation ? `, ${m.ownership.needsCardConfirmation} card(s) to confirm` : ''),
    );
  }

  L.push('');
  L.push(
    `  Model calls           ${String(m.model.calls).padStart(7)}  ` +
      `${m.model.escalated} escalated · ${m.model.blocked} withheld · ${m.model.unavailable} unavailable`,
  );
  if (m.model.costUsd > 0) L.push(`  Model spend           ${('$' + m.model.costUsd.toFixed(4)).padStart(7)}`);

  if (m.sync) {
    L.push('');
    L.push(
      m.sync.lastSyncAt
        ? `  Last sync             ${String(m.sync.ageMinutes).padStart(5)}m  ${m.sync.ok ? 'healthy' : `STALE${m.sync.error ? ` — ${m.sync.error}` : ''}`}`
        : '  Last sync             never — run backfill',
    );
  }

  return L.join('\n');
}
