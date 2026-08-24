import type { Extraction } from '../signal.ts';
import { evidenced, scan, dedupeExtractions } from './util.ts';

const V = 'ident@1';

/**
 * Masked card tails as they appear across his issuers:
 *   XXXX 8801 · XXXX-XXXX-XXXX-5678 · xx4417 · ····8842
 */
/**
 * Every quantifier is bounded and a separator is *required* between mask runs.
 *
 * The original nested two unbounded quantifiers — `(?:[x…]{2,}[\s-]*){1,4}` —
 * which let the engine split one run of x's an exponential number of ways.
 * Forty characters took over twenty seconds. Requiring a separator between
 * groups removes the ambiguity entirely: a run can only end where a separator
 * begins.
 */
const MASKED_TAIL =
  /([x*·•●]{2,20}(?:[\s\-–]{1,3}[x*·•●]{2,20}){0,3})[\s\-–]{0,3}(\d{4})\b/gi;
const WORDED_TAIL = /\b(?:ending(?:\s+(?:in|with))?|last\s*4(?:\s*digits)?)\D{0,8}(\d{4})\b/gi;

/**
 * Aadhaar is also printed as a masked 12-digit number ("XXXX XXXX 8563") and
 * would otherwise be harvested as a card tail. It is a government identifier,
 * never a card, and must never reach a model — so it is excluded here and
 * redacted before any API call.
 */
const AADHAAR_NEAR = /aadhaar|uidai/i;

export function extractCardTails(text: string): Extraction[] {
  const masked = scan(text, MASKED_TAIL, (m) => {
    const before = text.slice(Math.max(0, m.index - 30), m.index);
    if (AADHAAR_NEAR.test(before)) return null;
    return evidenced(text, 'card_last4', m[0], m.index, { valueText: m[2] }, V);
  });
  const worded = scan(text, WORDED_TAIL, (m) =>
    evidenced(text, 'card_last4', m[0], m.index, { valueText: m[1] }, V),
  );
  return dedupeExtractions([...masked, ...worded]);
}

/** UPI virtual payment addresses: yourname0-1@okaxis, merchant@ybl */
const VPA = /\b([a-z0-9][a-z0-9._\-]{1,})@(ok[a-z]+|[a-z]+bank|ybl|paytm|apl|axl|ibl|upi)\b/gi;

export function extractVpas(text: string): Extraction[] {
  return dedupeExtractions(
    scan(text, VPA, (m) => evidenced(text, 'vpa', m[0], m.index, { valueText: m[0].toLowerCase() }, V)),
  );
}

/**
 * Ticket, request and order identifiers. A reference number in a subject line
 * is near-proof that the thread is an open loop — it is the cheapest, most
 * reliable seed the Follow-Up Desk has, and it needs no model to find.
 */
const LABELLED_REF =
  /\b(?:ticket|request|case|complaint|order(?:\s*id)?|ref(?:erence)?(?:\s*(?:no|number))?|crn)\b[\s#:.\-]*\(?\s*([A-Z]{0,4}-?\d{3,12})\s*\)?/gi;
const HASH_REF = /\[?#\s?(\d{3,12})\]?/g;

export function extractTicketIds(text: string): Extraction[] {
  const labelled = scan(text, LABELLED_REF, (m) =>
    evidenced(text, 'ticket_id', m[0], m.index, { valueText: m[1].toUpperCase() }, V),
  );
  const hashed = scan(text, HASH_REF, (m) =>
    evidenced(text, 'ticket_id', m[0], m.index, { valueText: m[1] }, V),
  );
  return dedupeExtractions([...labelled, ...hashed]);
}

/**
 * The address a bounce says is undeliverable. Pulled from the DSN body, which
 * always names the failed recipient in plain text.
 */
const DEAD_ADDR =
  /(?:message\s+to|to\s+the\s+following|recipient|address)\s+<?([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})>?/gi;
const BARE_ADDR = /\b([a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,})\b/gi;

export function extractDeadAddress(text: string): Extraction[] {
  const labelled = scan(text, DEAD_ADDR, (m) =>
    evidenced(text, 'dead_address', m[0], m.index, { valueText: m[1].toLowerCase() }, V),
  );
  if (labelled.length) return dedupeExtractions(labelled);
  // Fall back to the first support-shaped address mentioned in the report.
  const bare = scan(text, BARE_ADDR, (m) => {
    const a = m[1].toLowerCase();
    if (/mailer-daemon|postmaster|googlemail|noreply|no-reply/.test(a)) return null;
    return evidenced(text, 'dead_address', m[0], m.index, { valueText: a }, V);
  });
  return dedupeExtractions(bare).slice(0, 1);
}
