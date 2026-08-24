import type { Signal, TriagedSignal, Extraction } from './signal.ts';
import type { ObligationDraft } from './obligation.ts';
import { runRulepack } from './rulepack/index.ts';
import type { Rule, UrgencyFloor } from './rulepack/types.ts';
import { PARSERS } from './parsers/registry.ts';
import { extractAmounts } from './extract/amount.ts';
import { extractDates } from './extract/date.ts';
import { extractCardTails, extractTicketIds, extractVpas, extractDeadAddress } from './extract/identifiers.ts';
import { dedupeExtractions } from './extract/util.ts';
import { checkOwnership } from './ownership.ts';

export interface TriageResult extends TriagedSignal {
  obligation?: ObligationDraft;
  /** An unrecognised card tail: counted as his, but worth one tap to confirm. */
  needsCardConfirmation?: { reason: string; evidence?: string };
  /** Set when a sender-specific parser matched but could not read the body. */
  quarantine?: string;
  opensLoop: boolean;
}

/**
 * Tier 0 end to end: rulepack → sender parser → generic extractors → ownership.
 *
 * Nothing here calls a model. Everything that survives with `skipLlm` true is
 * classified for free and will stay that way; everything else falls through to
 * Tier 1 wearing an honest `needs_review`.
 */
export function triage(
  sig: Signal,
  opts: { rules?: Rule[]; floors?: UrgencyFloor[] } = {},
): TriageResult {
  const hit = runRulepack(sig, opts.rules, opts.floors);
  const { classification, rule } = hit;

  let extractions: Extraction[] = [];
  let obligation: ObligationDraft | undefined;
  let quarantine: string | undefined;

  const parserName = rule?.then.parser;
  if (parserName && PARSERS[parserName]) {
    const parsed = PARSERS[parserName](sig);
    extractions.push(...parsed.extractions);
    obligation = parsed.obligation;
    quarantine = parsed.quarantine;
  }

  // Generic extractors run for anything that could carry an obligation. Promo
  // and security mail is skipped: it is full of amounts and dates that are
  // advertising copy, and harvesting them would manufacture phantom deadlines.
  const worthExtracting = !['promo', 'security'].includes(classification.category);
  if (worthExtracting) {
    extractions.push(
      ...extractAmounts(sig.text),
      ...extractDates(sig.text),
      ...extractCardTails(sig.text),
      ...extractTicketIds(sig.text),
      ...extractVpas(sig.text),
    );
  }
  if (classification.category === 'bounce') {
    extractions.push(...extractDeadAddress(sig.text));
  }

  extractions = dedupeExtractions(extractions);

  const ownership = checkOwnership(sig, classification.category, extractions);

  return {
    signal: sig,
    classification,
    extractions,
    obligation: ownership.ok ? obligation : undefined,
    notYours:
      ownership.status === 'foreign'
        ? { reason: ownership.reason!, evidence: ownership.evidence }
        : undefined,
    needsCardConfirmation:
      ownership.status === 'unknown_card'
        ? { reason: ownership.reason!, evidence: ownership.evidence }
        : undefined,
    quarantine,
    opensLoop: Boolean(rule?.then.opensLoop),
  };
}
