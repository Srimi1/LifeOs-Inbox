/**
 * Closed enums. Nothing in this file may become free text.
 *
 * Every classifier — rulepack, LLM, or human — must land inside these
 * vocabularies. `other` and `needs_review` are the honesty valves: a
 * classifier forced to pick a real value when it is unsure will confabulate,
 * so both are always legal answers.
 */

export const CATEGORIES = [
  'bill',
  'transaction',
  'renewal',
  'investment',
  'support',
  'bounce',
  'dev',
  'career',
  'security',
  'promo',
  'personal',
  'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const URGENCIES = ['now', 'today', 'this_week', 'someday', 'none'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const ACTIONS = [
  'reply',
  'pay',
  'decide',
  'follow_up',
  'wait',
  'convert_task',
  'archive',
  'needs_review',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Enum, not a float. There are no logprobs; false precision is worse than none. */
export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const METHODS = ['rule', 'llm', 'user'] as const;
export type Method = (typeof METHODS)[number];

export const EXTRACT_KINDS = [
  'amount',
  'min_due',
  'due_date',
  'card_last4',
  'merchant',
  'ticket_id',
  'vpa',
  'dead_address',
] as const;
export type ExtractKind = (typeof EXTRACT_KINDS)[number];

/** Ordered weakest → strongest, so urgency floors can only ever escalate. */
const URGENCY_RANK: Record<Urgency, number> = {
  none: 0,
  someday: 1,
  this_week: 2,
  today: 3,
  now: 4,
};

export function maxUrgency(a: Urgency, b: Urgency): Urgency {
  return URGENCY_RANK[a] >= URGENCY_RANK[b] ? a : b;
}

export function isUrgent(u: Urgency): boolean {
  return URGENCY_RANK[u] >= URGENCY_RANK.today;
}

export function isCategory(v: string): v is Category {
  return (CATEGORIES as readonly string[]).includes(v);
}
