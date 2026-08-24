import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Signal, Extraction } from './signal.ts';
import type { Category } from './taxonomy.ts';

/**
 * The inbox provably contains at least one other person's brokerage statement.
 * Nothing may enter the Money Ledger as his spend until it clears this guard —
 * counting a family member's portfolio as his own would poison every number
 * the module reports, silently and permanently.
 */
export interface OwnerProfile {
  /** Card tails he actually holds. Anything else is not his. */
  cardLast4: string[];
  /** Lowercase name tokens that identify him in a greeting. */
  nameTokens: string[];
  addresses: string[];
}

/**
 * The owner profile is personal and lives outside version control:
 * copy `owner.example.json` to `owner.json` (repo root) and fill it in.
 *
 * With no config the guard fails closed — every extracted card tail counts as
 * foreign and every named greeting counts as someone else — because a silent
 * pass-through would be exactly the failure this module exists to prevent.
 */
export const EMPTY_OWNER: OwnerProfile = { cardLast4: [], nameTokens: [], addresses: [] };

const DEFAULT_OWNER_PATH = fileURLToPath(new URL('../../../owner.json', import.meta.url));

let cachedOwner: OwnerProfile | undefined;

export function loadOwner(path: string = DEFAULT_OWNER_PATH): OwnerProfile {
  if (cachedOwner) return cachedOwner;
  let profile = EMPTY_OWNER;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<OwnerProfile>;
    profile = {
      cardLast4: (raw.cardLast4 ?? []).map(String),
      nameTokens: (raw.nameTokens ?? []).map((t) => String(t).toLowerCase()),
      addresses: (raw.addresses ?? []).map((a) => String(a).toLowerCase()),
    };
  } catch {
    console.warn(
      '[lifeos/core] owner.json not found or unreadable — the ownership guard will flag financial signals as not-yours. Copy owner.example.json to owner.json and fill it in.',
    );
  }
  cachedOwner = profile;
  return profile;
}

/** Salutations that address a role rather than a person. */
const GENERIC = new Set([
  'customer', 'user', 'member', 'sir', 'madam', 'shareholder', 'student',
  'investor', 'reader', 'guest', 'team', 'there', 'friend', 'subscriber',
  'applicant', 'candidate', 'client', 'partner',
]);

/**
 * Words that begin a sentence rather than a name.
 *
 * "Hello, We've got the weekly report" has no addressee at all, but the
 * capital W after the comma reads exactly like a surname — and on the first
 * run it flagged two of his own Groww statements as someone else's mail.
 */
const SENTENCE_START = new Set([
  'we', 'i', 'you', 'your', 'thank', 'thanks', 'please', 'here', 'this', 'that',
  'these', 'it', 'welcome', 'greetings', 'stay', 'get', 'congratulations',
  'good', 'hope', 'as', 'if', 'just', 'our', 'my', 'the', 'a', 'an', 'so',
  'now', 'great', 'happy', 'looking', 'need', 'want', 'ready', 'check', 'save',
]);

/**
 * The salutation is matched case-insensitively but the name is not: an
 * initial capital is most of what distinguishes "Hello Poonam Sharma" from
 * "hello there". The `i` flag cannot be used for that reason — applying it to
 * the whole pattern would let any lowercase word be read as a person's name.
 */
const GREETING =
  /\b(?:[Hh]ello|[Hh]i|[Dd]ear|[Hh]ey|HELLO|HI|DEAR)[,!]?\s+((?:[A-Z][A-Za-z.'-]+\s+){0,2}[A-Z][A-Za-z.'-]+)/g;

const FINANCIAL: Category[] = ['bill', 'transaction', 'investment', 'renewal'];

/**
 * `foreign` blocks; `unknown_card` only asks.
 *
 * The distinction matters more than it looks. A hardcoded tail allowlist can
 * never be complete — the first run flagged three of his own Razorpay receipts
 * as somebody else's simply because that card had not appeared in a bill yet.
 * Excluding real spend is exactly as damaging as including foreign spend, so an
 * unrecognised tail becomes a one-tap "is this your card?" rather than a silent
 * exclusion. Only a mail that greets a different human is refused outright.
 */
export type OwnershipStatus = 'ok' | 'unknown_card' | 'foreign';

export interface OwnershipVerdict {
  /** False only for `foreign`. `unknown_card` still counts as his, pending confirmation. */
  ok: boolean;
  status: OwnershipStatus;
  reason?: string;
  evidence?: string;
}

export function checkOwnership(
  sig: Signal,
  category: Category,
  extractions: Extraction[],
  owner: OwnerProfile = loadOwner(),
): OwnershipVerdict {
  if (!FINANCIAL.includes(category)) return { ok: true, status: 'ok' };

  // Who the mail greets is the decisive test: a statement addressed to another
  // person is not his, whatever card it mentions.
  const rx = new RegExp(GREETING.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = rx.exec(sig.text)) !== null) {
    const name = m[1].trim();
    // Strip contractions ("We've" → "we") so a sentence opener cannot disguise
    // itself as a surname, then test for him before testing for anyone else.
    const tokens = name
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/['’].*$/, '').replace(/[.,!]/g, ''));
    if (tokens.some((t) => owner.nameTokens.includes(t))) break;
    if (tokens.every((t) => GENERIC.has(t) || SENTENCE_START.has(t))) continue;
    return {
      ok: false,
      status: 'foreign',
      reason: `addressed to ${name}, not you`,
      evidence: m[0],
    };
  }

  const unknown = extractions
    .filter((e) => e.kind === 'card_last4' && e.valueText)
    .find((e) => !owner.cardLast4.includes(e.valueText!));
  if (unknown) {
    return {
      ok: true,
      status: 'unknown_card',
      reason: `card ending ${unknown.valueText} is not on your list yet`,
      evidence: unknown.evidence,
    };
  }

  return { ok: true, status: 'ok' };
}
