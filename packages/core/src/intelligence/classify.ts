import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { Signal, Extraction } from '../signal.ts';
import type { Confidence } from '../taxonomy.ts';
import { triage, type TriageResult } from '../triage.ts';
import { SEED_RULES } from '../rulepack/seed.ts';
import { redact, truncateForModel } from './redact.ts';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.ts';
import { validateClassification, type ModelClassification } from './schema.ts';
import {
  classifyWithModel,
  resolveMode,
  NoCassetteError,
  ModelDisabledError,
  PROMPT_VERSION,
  type CallMode,
} from './client.ts';
import { findOverride, promotedRulesAsRulepack, loadCorrections, loadPromotedRules } from './overrides.ts';

const DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));
const AUDIT_PATH = join(DATA_DIR, 'ai-audit.jsonl');

export interface AuditRecord {
  signalId: string;
  at: string;
  tier: 0 | 1 | 2;
  model: string;
  promptVersion: string;
  fromCassette: boolean;
  outcome: 'resolved' | 'escalated' | 'needs_review' | 'blocked' | 'unavailable';
  category?: string;
  urgency?: string;
  confidence?: Confidence;
  reason?: string;
  droppedExtractions: string[];
  validationErrors?: string[];
  redactionCount: number;
  latencyMs: number;
  costUsd?: number;
}

/**
 * Every model decision is written down. This one file is simultaneously the
 * debugging tool, the regression dataset and the correction-rate dashboard —
 * and it is what makes "why is this here?" answerable in the UI. Retrofitting
 * auditability after the fact is miserable, so it exists from the first call.
 */
export function appendAudit(rec: AuditRecord): void {
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(AUDIT_PATH, JSON.stringify(rec) + '\n');
}

export interface ClassifyOptions {
  mode?: CallMode;
  /** Write to the audit log. Off inside the eval harness. */
  audit?: boolean;
  now?: Date;
}

/** Money and deadlines get a second opinion even when Tier 1 sounds sure. */
const HIGH_STAKES = /(?:₹|Rs\.?|INR)\s?[\d,]{3,}|due date|last date|suspend|overdue|payment failed/i;

function toExtraction(m: ModelClassification['extractions'][number], shown: string): Extraction {
  const offset = shown.indexOf(m.evidence);
  return {
    kind: m.kind,
    valueText: m.kind === 'due_date' ? undefined : m.value,
    valueDate: m.kind === 'due_date' ? m.value : undefined,
    valueNum: m.kind === 'amount' || m.kind === 'min_due' ? Number(m.value.replace(/[^\d.]/g, '')) : undefined,
    currency: m.kind === 'amount' || m.kind === 'min_due' ? 'INR' : undefined,
    evidence: m.evidence,
    offset: offset < 0 ? 0 : offset,
    method: 'llm',
    extractorVersion: PROMPT_VERSION,
  };
}

/**
 * Compose the confidence the product acts on.
 *
 * The API exposes no logprobs, so a numeric score would be false precision.
 * What we have instead is three cheap signals: whether the mechanical checks
 * passed, what the model says about itself, and whether it agrees with what
 * the owner has previously decided about this sender. Any of them failing
 * drags the result down, because the asymmetry is unforgiving — a needless
 * escalation costs a tap, a confident mistake costs the product.
 */
function composeConfidence(
  model: ModelClassification,
  dropped: string[],
  agreesWithHistory: boolean | undefined,
): Confidence {
  if (model.needs_human) return 'low';
  if (dropped.length) return model.confidence === 'high' ? 'medium' : 'low';
  if (agreesWithHistory === false) return 'low';
  if (agreesWithHistory === true && model.confidence === 'high') return 'high';
  return model.confidence;
}

/**
 * Full pipeline: override → Tier 0 → Tier 1 → Tier 2 → human.
 *
 * A signal only ever moves *up* this ladder. Nothing here can downgrade an
 * urgency the deterministic floor already set, and nothing can overwrite a
 * correction the owner has made.
 */
export async function classifySignal(sig: Signal, opts: ClassifyOptions = {}): Promise<TriageResult> {
  const mode = opts.mode ?? resolveMode();
  const audit = opts.audit ?? true;

  // 1. A human decision, consulted before anything else and never overridden.
  const override = findOverride(sig);
  if (override) {
    const base = triage(sig);
    return {
      ...base,
      classification: {
        ...base.classification,
        category: override.category,
        urgency: override.urgency ?? base.classification.urgency,
        action: override.action ?? base.classification.action,
        confidence: 'high',
        method: 'user',
        classifierVersion: 'user-override',
        ruleIds: [...base.classification.ruleIds, 'override'],
        skipLlm: true,
      },
    };
  }

  // 2. Tier 0, including any rules promoted from past corrections.
  const rules = [...promotedRulesAsRulepack(), ...SEED_RULES];
  const base = triage(sig, { rules });
  if (base.classification.skipLlm) return base;

  // 3. Redaction. A message carrying a live credential is never transmitted.
  const red = redact(sig.text);
  if (red.blocked) {
    if (audit) {
      appendAudit({
        signalId: sig.externalId,
        at: new Date().toISOString(),
        tier: 0,
        model: 'none',
        promptVersion: PROMPT_VERSION,
        fromCassette: false,
        outcome: 'blocked',
        reason: red.blockedReason,
        droppedExtractions: [],
        redactionCount: 0,
        latencyMs: 0,
      });
    }
    return withReview(base, red.blockedReason ?? 'withheld from model');
  }

  const shown = truncateForModel(red.text);
  const user = buildUserMessage(sig, shown);
  const historical = loadCorrections().filter((c) => c.senderAddr === sig.senderAddr);

  for (const tier of [1, 2] as const) {
    let result;
    try {
      result = await classifyWithModel({ tier, system: SYSTEM_PROMPT, user }, mode);
    } catch (err) {
      if (err instanceof NoCassetteError || err instanceof ModelDisabledError) {
        if (audit) {
          appendAudit({
            signalId: sig.externalId,
            at: new Date().toISOString(),
            tier,
            model: 'none',
            promptVersion: PROMPT_VERSION,
            fromCassette: false,
            outcome: 'unavailable',
            reason: err.message,
            droppedExtractions: [],
            redactionCount: red.redactions.length,
            latencyMs: 0,
          });
        }
        return withReview(base, 'model unavailable');
      }
      throw err;
    }

    const validated = validateClassification(result.raw, shown, sig.occurredAt);

    if (!validated.ok) {
      // A malformed response is not retried in a loop — it escalates once and
      // then becomes a human's problem. Looping on a bad response burns money
      // to arrive at the same place.
      if (audit) {
        appendAudit({
          signalId: sig.externalId,
          at: new Date().toISOString(),
          tier,
          model: result.model,
          promptVersion: PROMPT_VERSION,
          fromCassette: result.fromCassette,
          outcome: tier === 1 ? 'escalated' : 'needs_review',
          validationErrors: validated.errors,
          droppedExtractions: [],
          redactionCount: red.redactions.length,
          latencyMs: result.latencyMs,
          costUsd: result.costUsd,
        });
      }
      if (tier === 2) return withReview(base, `validation failed: ${validated.errors[0]}`);
      continue;
    }

    const m = validated.value;
    const agrees = historical.length
      ? historical[historical.length - 1].category === m.category
      : undefined;
    const confidence = composeConfidence(m, validated.dropped, agrees);

    const mustEscalate =
      tier === 1 &&
      (m.needs_human ||
        confidence === 'low' ||
        m.category === 'other' ||
        m.action === 'needs_review' ||
        (HIGH_STAKES.test(sig.text) && confidence !== 'high'));

    if (audit) {
      appendAudit({
        signalId: sig.externalId,
        at: new Date().toISOString(),
        tier,
        model: result.model,
        promptVersion: PROMPT_VERSION,
        fromCassette: result.fromCassette,
        outcome: mustEscalate ? 'escalated' : 'resolved',
        category: m.category,
        urgency: m.urgency,
        confidence,
        reason: m.reason,
        droppedExtractions: validated.dropped,
        redactionCount: red.redactions.length,
        latencyMs: result.latencyMs,
        costUsd: result.costUsd,
      });
    }

    if (mustEscalate) continue;

    // The deterministic urgency floor still wins: a model may raise urgency,
    // never lower what a rule already established.
    const floored = base.classification.urgency;
    const urgency = rankUrgency(m.urgency) > rankUrgency(floored) ? m.urgency : floored;

    return {
      ...base,
      classification: {
        category: m.category,
        urgency,
        action: m.action,
        confidence,
        method: 'llm',
        classifierVersion: `${result.model}/${PROMPT_VERSION}`,
        ruleIds: base.classification.ruleIds,
        skipLlm: false,
      },
      extractions: [...base.extractions, ...m.extractions.map((e) => toExtraction(e, shown))],
    };
  }

  return withReview(base, 'both tiers declined to resolve');
}

function rankUrgency(u: string): number {
  return ['none', 'someday', 'this_week', 'today', 'now'].indexOf(u);
}

function withReview(base: TriageResult, reason: string): TriageResult {
  return {
    ...base,
    classification: {
      ...base.classification,
      action: 'needs_review',
      confidence: 'low',
      ruleIds: [...base.classification.ruleIds, `review:${reason}`],
      skipLlm: false,
    },
  };
}

export { loadCorrections, loadPromotedRules };
