import { CATEGORIES, URGENCIES, ACTIONS, EXTRACT_KINDS } from '../taxonomy.ts';
import type { Category, Urgency, Action, Confidence, ExtractKind } from '../taxonomy.ts';

/**
 * The model's output contract.
 *
 * Structured outputs make malformed JSON stop being a failure mode at the
 * transport layer. They do not make the *content* true, so everything below
 * re-checks semantics in our own code: enums in range, dates plausible, and
 * above all every extracted value quoted verbatim from the text the model was
 * actually shown. Belt and braces, because the cost of a wrong due date is not
 * symmetric with the cost of a rejected one.
 */
export const CLASSIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'urgency', 'action', 'confidence', 'needs_human', 'reason', 'extractions'],
  properties: {
    category: { type: 'string', enum: [...CATEGORIES] },
    urgency: { type: 'string', enum: [...URGENCIES] },
    action: { type: 'string', enum: [...ACTIONS] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    // An explicit way to say "I don't know". A model forced to pick a real
    // category when it is unsure will confabulate one; giving it a legal exit
    // is cheaper than catching the invention downstream.
    needs_human: { type: 'boolean' },
    reason: { type: 'string', maxLength: 200 },
    extractions: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'value', 'evidence'],
        properties: {
          kind: { type: 'string', enum: [...EXTRACT_KINDS] },
          value: { type: 'string' },
          // Must be copied character-for-character out of the message.
          evidence: { type: 'string', minLength: 2, maxLength: 120 },
        },
      },
    },
  },
} as const;

export interface ModelExtraction {
  kind: ExtractKind;
  value: string;
  evidence: string;
}

export interface ModelClassification {
  category: Category;
  urgency: Urgency;
  action: Action;
  confidence: Confidence;
  needs_human: boolean;
  reason: string;
  extractions: ModelExtraction[];
}

export type ValidationResult =
  | { ok: true; value: ModelClassification; dropped: string[] }
  | { ok: false; errors: string[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate a model response against the text it was shown.
 *
 * Enum or shape violations reject the whole response — that is a retry.
 * A single bad *extraction* does not: it is dropped with a note, because
 * losing one field is recoverable while discarding a correct classification
 * over it is just waste. The dropped list is recorded in the audit trail.
 */
export function validateClassification(
  raw: unknown,
  shownText: string,
  emailDate?: string,
): ValidationResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) return { ok: false, errors: ['response is not an object'] };
  const r = raw as Record<string, unknown>;

  const inEnum = <T extends string>(v: unknown, allowed: readonly T[], field: string): T | undefined => {
    if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
      errors.push(`${field}: ${JSON.stringify(v)} is not one of ${allowed.join('|')}`);
      return undefined;
    }
    return v as T;
  };

  const category = inEnum(r.category, CATEGORIES, 'category');
  const urgency = inEnum(r.urgency, URGENCIES, 'urgency');
  const action = inEnum(r.action, ACTIONS, 'action');
  const confidence = inEnum(r.confidence, ['high', 'medium', 'low'] as const, 'confidence');
  if (typeof r.needs_human !== 'boolean') errors.push('needs_human: expected boolean');
  if (typeof r.reason !== 'string') errors.push('reason: expected string');
  if (!Array.isArray(r.extractions)) errors.push('extractions: expected array');

  if (errors.length) return { ok: false, errors };

  const dropped: string[] = [];
  const extractions: ModelExtraction[] = [];

  // Normalise whitespace on both sides before comparing: mail bodies are full
  // of non-breaking spaces and a model will reasonably normalise them when
  // quoting. Requiring byte equality there would reject correct evidence.
  const haystack = shownText.replace(/\s+/g, ' ');

  for (const item of r.extractions as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      dropped.push('extraction is not an object');
      continue;
    }
    const e = item as Record<string, unknown>;
    const kind = typeof e.kind === 'string' ? e.kind : '';
    const value = typeof e.value === 'string' ? e.value : '';
    const evidence = typeof e.evidence === 'string' ? e.evidence : '';

    if (!(EXTRACT_KINDS as readonly string[]).includes(kind)) {
      dropped.push(`unknown kind ${JSON.stringify(kind)}`);
      continue;
    }
    if (!evidence || !value) {
      dropped.push(`${kind}: missing value or evidence`);
      continue;
    }
    // THE guardrail. If the model cannot point at where it read this, it did
    // not read it, and the extraction does not exist.
    if (!haystack.includes(evidence.replace(/\s+/g, ' '))) {
      dropped.push(`${kind}: evidence not found verbatim — ${JSON.stringify(evidence.slice(0, 48))}`);
      continue;
    }
    if (kind === 'due_date') {
      if (!ISO_DATE.test(value)) {
        dropped.push(`due_date: ${JSON.stringify(value)} is not YYYY-MM-DD`);
        continue;
      }
      const t = Date.parse(`${value}T00:00:00Z`);
      if (Number.isNaN(t)) {
        dropped.push(`due_date: ${value} is not a real date`);
        continue;
      }
      // A due date wildly distant from the mail that carried it is a
      // misparse, most often a year picked out of a footer.
      const base = emailDate ? Date.parse(emailDate) : Date.now();
      const years = Math.abs(t - base) / (365 * 86_400_000);
      if (years > 3) {
        dropped.push(`due_date: ${value} is ${years.toFixed(1)}y from the message date`);
        continue;
      }
    }
    if (kind === 'amount' || kind === 'min_due') {
      const n = Number(value.replace(/[^\d.]/g, ''));
      if (!Number.isFinite(n) || n < 0) {
        dropped.push(`${kind}: ${JSON.stringify(value)} is not a number`);
        continue;
      }
    }

    extractions.push({ kind: kind as ExtractKind, value, evidence });
  }

  return {
    ok: true,
    dropped,
    value: {
      category: category!,
      urgency: urgency!,
      action: action!,
      confidence: confidence!,
      needs_human: r.needs_human as boolean,
      reason: (r.reason as string).slice(0, 200),
      extractions,
    },
  };
}
