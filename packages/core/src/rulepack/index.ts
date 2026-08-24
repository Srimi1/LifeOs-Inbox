import type { Signal, Classification } from '../signal.ts';
import { maxUrgency } from '../taxonomy.ts';
import type { Rule, UrgencyFloor } from './types.ts';
import { matches } from './types.ts';
import { SEED_RULES, URGENCY_FLOORS, RULEPACK_VERSION } from './seed.ts';

export { SEED_RULES, URGENCY_FLOORS, RULEPACK_VERSION };
export * from './types.ts';

export interface RuleHit {
  classification: Classification;
  rule?: Rule;
  floors: UrgencyFloor[];
}

/**
 * Tier 0. Deterministic, free, and instantaneous.
 *
 * A miss here is not a failure — it falls through to Tier 1 with an honest
 * `needs_review`. What must never happen is a confident wrong answer, so the
 * only way to get `skipLlm` is for a rule that declares it fully resolves the
 * signal to have won outright.
 */
export function runRulepack(
  sig: Signal,
  rules: Rule[] = SEED_RULES,
  floors: UrgencyFloor[] = URGENCY_FLOORS,
): RuleHit {
  const hits = rules
    .filter((r) => matches(sig, r.when))
    .sort((a, b) => b.priority - a.priority);
  const winner = hits[0];

  const firedFloors = floors.filter((f) => matches(sig, f.when));

  let urgency = winner?.then.urgency ?? 'none';
  let action = winner?.then.action ?? 'needs_review';

  for (const f of firedFloors) {
    const escalated = maxUrgency(urgency, f.floor);
    if (escalated !== urgency) {
      urgency = escalated;
      if (f.action) action = f.action;
    }
  }

  const resolved = winner ? winner.then.resolves !== false : false;

  return {
    rule: winner,
    floors: firedFloors,
    classification: {
      category: winner?.then.category ?? 'other',
      urgency,
      action: winner ? action : 'needs_review',
      confidence: resolved ? 'high' : winner ? 'medium' : 'low',
      method: 'rule',
      classifierVersion: RULEPACK_VERSION,
      ruleIds: [...hits.map((h) => h.id), ...firedFloors.map((f) => f.id)],
      skipLlm: resolved,
    },
  };
}
