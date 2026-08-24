import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Category, Urgency, Action, Method } from '../taxonomy.ts';
import type { Signal } from '../signal.ts';
import type { Rule } from '../rulepack/types.ts';

/**
 * Corrections, and the machinery that turns them into rules.
 *
 * This is the trust engine. A correction is consulted *before* any model call,
 * so once the owner has fixed something it stays fixed no matter what a future
 * model or prompt version thinks. And after three consistent corrections for
 * the same sender the decision is promoted into a deterministic Tier-0 rule,
 * which removes the model from that path entirely.
 *
 * The direction of travel matters: the system gets more deterministic the more
 * it is used, so both the running cost and the surface area for error shrink
 * every week rather than growing.
 */
const DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));
const CORRECTIONS_PATH = join(DATA_DIR, 'corrections.json');
const PROMOTIONS_PATH = join(DATA_DIR, 'promoted-rules.json');

/** How many identical corrections before a rule is proposed. */
export const PROMOTION_THRESHOLD = 3;

/**
 * How long a shape-level override keeps applying to *new* mail.
 *
 * An override on the exact message is permanent — that was a decision about a
 * specific thing. Extending it to every future message of the same shape is a
 * convenience, and an unbounded one is dangerous: a single misclick on "Your
 * statement is ready" would stop that card minting bills forever, silently.
 * Ninety days is long enough to be useful and short enough that a mistake
 * heals itself.
 */
export const SHAPE_OVERRIDE_TTL_DAYS = 90;

export interface Correction {
  /** The matcher this correction keys on — sender address, usually. */
  senderAddr: string;
  senderDomain: string;
  /** Subject shape, with varying tokens masked, so a series matches. */
  subjectShape: string;
  category: Category;
  urgency?: Urgency;
  action?: Action;
  signalId: string;
  correctedAt: string;
  /** What the pipeline had said, for measuring the correction rate. */
  previous?: { category: Category; urgency: Urgency; action: Action; method: Method };
}

export interface PromotedRule {
  id: string;
  senderAddr: string;
  /** Present when the corrections all shared one subject shape. */
  subjectShape?: string;
  category: Category;
  urgency?: Urgency;
  action?: Action;
  fromCorrections: number;
  promotedAt: string;
  enabled: boolean;
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function loadCorrections(): Correction[] {
  return readJson<Correction[]>(CORRECTIONS_PATH, []);
}

export function loadPromotedRules(): PromotedRule[] {
  return readJson<PromotedRule[]>(PROMOTIONS_PATH, []);
}

/** Mask the parts of a subject that vary between messages in a series. */
export function subjectShape(title: string): string {
  return title
    .replace(/\b[0-9a-f]{7,40}\b/gi, '#')
    .replace(/\b\d[\d,.]*\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 80);
}

export function recordCorrection(
  sig: Signal,
  fix: { category: Category; urgency?: Urgency; action?: Action },
  previous?: Correction['previous'],
): { corrections: Correction[]; proposal?: PromotedRule } {
  const corrections = loadCorrections();
  corrections.push({
    senderAddr: sig.senderAddr,
    senderDomain: sig.senderDomain,
    subjectShape: subjectShape(sig.title),
    category: fix.category,
    urgency: fix.urgency,
    action: fix.action,
    signalId: sig.externalId,
    correctedAt: new Date().toISOString(),
    previous,
  });
  writeJson(CORRECTIONS_PATH, corrections);
  return { corrections, proposal: proposeRule(sig.senderAddr, corrections) };
}

/**
 * A rule is proposed only when the sender has been corrected the same way
 * `PROMOTION_THRESHOLD` times. Two identical corrections is a coincidence;
 * three is a pattern worth hard-coding.
 */
export function proposeRule(senderAddr: string, corrections = loadCorrections()): PromotedRule | undefined {
  const forSender = corrections.filter((c) => c.senderAddr === senderAddr);
  if (forSender.length < PROMOTION_THRESHOLD) return undefined;

  const recent = forSender.slice(-PROMOTION_THRESHOLD);
  const first = recent[0];
  const consistent = recent.every(
    (c) => c.category === first.category && c.urgency === first.urgency && c.action === first.action,
  );
  if (!consistent) return undefined;

  if (loadPromotedRules().some((r) => r.senderAddr === senderAddr)) return undefined;

  // Scope the rule to the evidence. Three corrections on one subject shape
  // say nothing about the sender's other mail — promoting to the whole address
  // would let three corrections on HDFC's loan offers start archiving its
  // transaction alerts.
  const shapes = [...new Set(recent.map((c) => c.subjectShape))];
  const subjectShapeScope = shapes.length === 1 ? shapes[0] : undefined;

  return {
    id: `promoted.${senderAddr.replace(/[^a-z0-9]+/gi, '-')}${subjectShapeScope ? '.shaped' : ''}`,
    senderAddr,
    subjectShape: subjectShapeScope,
    category: first.category,
    urgency: first.urgency,
    action: first.action,
    fromCorrections: forSender.length,
    promotedAt: new Date().toISOString(),
    enabled: true,
  };
}

/** Accept a proposal. From here the sender never reaches a model again. */
export function acceptRule(rule: PromotedRule): PromotedRule[] {
  const rules = loadPromotedRules().filter((r) => r.senderAddr !== rule.senderAddr);
  rules.push(rule);
  writeJson(PROMOTIONS_PATH, rules);
  return rules;
}

export function revokeRule(senderAddr: string): PromotedRule[] {
  const rules = loadPromotedRules().filter((r) => r.senderAddr !== senderAddr);
  writeJson(PROMOTIONS_PATH, rules);
  return rules;
}

/**
 * Promoted rules enter the rulepack above the seed rules: an explicit human
 * decision about a specific sender outranks anything shipped in the box.
 */
/** The shape is already masked; make it safe to compile and tolerant of digits. */
function escapeForShape(shape: string): string {
  return shape.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/#/g, '\\d[\\d,.]*');
}

export function promotedRulesAsRulepack(rules = loadPromotedRules()): Rule[] {
  return rules
    .filter((r) => r.enabled)
    .map((r) => ({
      id: r.id,
      note: `promoted from ${r.fromCorrections} corrections on ${r.promotedAt.slice(0, 10)}`,
      // A shape-scoped rule is specific enough to outrank the named senders.
      // A whole-address one is not, so it sits just below them and can only
      // win where nothing more specific applies.
      priority: r.subjectShape ? 96 : 80,
      when: {
        fromExact: [r.senderAddr],
        ...(r.subjectShape
          ? { subject: new RegExp(escapeForShape(r.subjectShape), 'i') }
          : {}),
      },
      then: {
        category: r.category,
        urgency: r.urgency,
        action: r.action,
        resolves: true,
      },
    }));
}

/**
 * The durable override for a single signal, consulted before any model call.
 * Exact signal id first, then the sender-and-subject shape so a correction
 * applies to the rest of a repeating series without waiting for promotion.
 */
export function findOverride(
  sig: Signal,
  corrections = loadCorrections(),
  now = new Date(),
): Correction | undefined {
  // A correction on this exact message never expires.
  const exact = corrections.filter((c) => c.signalId === sig.externalId).pop();
  if (exact) return exact;

  const shape = subjectShape(sig.title);
  const cutoff = now.getTime() - SHAPE_OVERRIDE_TTL_DAYS * 86_400_000;
  return corrections
    .filter(
      (c) =>
        c.senderAddr === sig.senderAddr &&
        c.subjectShape === shape &&
        Date.parse(c.correctedAt) >= cutoff,
    )
    .pop();
}

/**
 * The north-star reliability metric: corrections divided by model-classified
 * items over a window. Above 10% the pipeline is not trustworthy; under 5%
 * sustained is what unlocks silent auto-filing for a category.
 */
export function correctionRate(
  modelClassifiedCount: number,
  windowDays = 7,
  corrections = loadCorrections(),
): { rate: number; corrections: number; classified: number } {
  const cutoff = Date.now() - windowDays * 86_400_000;
  const recent = corrections.filter((c) => Date.parse(c.correctedAt) >= cutoff);
  return {
    rate: modelClassifiedCount ? recent.length / modelClassifiedCount : 0,
    corrections: recent.length,
    classified: modelClassifiedCount,
  };
}
