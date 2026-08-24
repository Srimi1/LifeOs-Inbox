import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Deterministic redaction, run before anything reaches a model API.
 *
 * This is the one place in the codebase where a regex failure is a privacy
 * failure rather than a wrong label, so it is deliberately aggressive: it
 * would rather mask a harmless number than leak an identifier. Placeholders
 * are typed, which preserves the model's ability to reason ("your
 * <CARD_****1234> bill of ₹1,234.00 is due") while the sensitive value stays
 * on this machine.
 *
 * Note on the word PAN: in Indian mail it means both a card Primary Account
 * Number and a Permanent Account Number (the tax ID). They are different
 * secrets with different shapes, so they are named CARD and TAXID here and
 * never conflated. His broker statements use the tax ID as a file password,
 * which makes leaking it materially worse than leaking a card tail.
 */

const DATA_DIR = fileURLToPath(new URL('../../../../data', import.meta.url));
const SALT_PATH = join(DATA_DIR, '.redaction-salt');

/**
 * A machine-local salt so hashed identifiers are stable across emails (the
 * same account always maps to the same token, which lets a model correlate)
 * but useless to anyone without this file.
 */
function salt(): string {
  if (existsSync(SALT_PATH)) return readFileSync(SALT_PATH, 'utf8').trim();
  mkdirSync(DATA_DIR, { recursive: true });
  const s = randomBytes(32).toString('hex');
  writeFileSync(SALT_PATH, s + '\n', { mode: 0o600 });
  return s;
}

let cachedSalt: string | undefined;
function tokenFor(kind: string, value: string): string {
  cachedSalt ??= salt();
  const h = createHash('sha256').update(`${cachedSalt}:${kind}:${value}`).digest('hex').slice(0, 8);
  return `<${kind}_${h}>`;
}

export interface Redaction {
  kind: string;
  original: string;
  placeholder: string;
  offset: number;
}

export interface RedactionResult {
  text: string;
  redactions: Redaction[];
  /** True when the text carries a secret that must never be sent at all. */
  blocked: boolean;
  blockedReason?: string;
}

// ---------------------------------------------------------------- validators

/** Luhn check — distinguishes a real card number from any 16-digit run. */
export function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

/** Aadhaar's checksum. Twelve digits alone is not enough to call it an Aadhaar. */
export function verhoeffValid(digits: string): boolean {
  if (!/^\d{12}$/.test(digits)) return false;
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) {
    c = VERHOEFF_D[c][VERHOEFF_P[i % 8][Number(reversed[i])]];
  }
  return c === 0;
}

// ------------------------------------------------------------------ patterns

/** An OTP in the body means the whole message is withheld, not masked. */
const OTP_CONTEXT = new RegExp(
  [
    '\\botp\\b',
    'one[\\s-]?time[\\s-]?(?:password|code|pin|use)',
    '\\b(?:verification|security|recovery|login|support|access|confirmation|authentication|auth)\\s+code\\b',
    '\\bpasscode\\b',
    // Bare codes, which is how most of them actually read. A currency symbol
    // immediately before the digits rules them out so bill amounts are never
    // mistaken for credentials.
    '\\b(?:use|enter)\\s+(?<![₹$])\\d{4,8}\\b',
    '(?<![₹$\\d.,])\\b\\d{4,8}\\b[^.]{0,40}\\b(?:expires?|do ?n.?t share|never share)\\b',
    '\\b(?:sign[\\s-]?in|log[\\s-]?in|verify|verification|authenticate)\\b[^.]{0,60}(?<![₹$])\\b\\d{4,8}\\b',
    '(?<![₹$\\d.,])\\b\\d{4,8}\\b\\s+is your\\b',
  ].join('|'),
  'i',
);

const CARD_RUN = /\b(?:\d[ -]?){13,19}\b/g;
const TAXID = /\b[A-Z]{5}\d{4}[A-Z]\b/g;
const AADHAAR_RUN = /\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g;
const ACCOUNT_NEAR =
  /\b(?:a\/c|acc(?:ount)?(?:\s*(?:no|number|#))?)\b[^\d]{0,12}(\d{9,18})\b/gi;
const INDIAN_MOBILE = /(?<![\d])(?:\+91[\s-]?|0)?[6-9]\d{9}(?![\d])/g;
const EMAIL_ADDR = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Redact in a fixed order, most-specific first: a twelve-digit Aadhaar would
 * otherwise be eaten by the card scanner, and an account number by the phone
 * scanner. Every replacement is length-tracked so offsets stay meaningful.
 */
export function redact(input: string, opts: { keepCardTail?: boolean } = {}): RedactionResult {
  const redactions: Redaction[] = [];
  let text = input;

  // A message containing a live credential is withheld entirely. There is no
  // classification worth the risk of transmitting an OTP.
  if (OTP_CONTEXT.test(input)) {
    return {
      text: '',
      redactions: [],
      blocked: true,
      blockedReason: 'contains a one-time code — never sent to any API',
    };
  }

  const replace = (re: RegExp, kind: string, build: (m: RegExpExecArray) => string | null): void => {
    text = text.replace(re, (...args) => {
      const m = args as unknown as RegExpExecArray;
      const whole = String(args[0]);
      const offset = Number(args[args.length - 2]);
      const placeholder = build(m);
      if (placeholder === null) return whole;
      redactions.push({ kind, original: whole, placeholder, offset });
      return placeholder;
    });
  };

  replace(TAXID, 'TAXID', () => '<TAXID>');

  replace(AADHAAR_RUN, 'AADHAAR', (m) => {
    const digits = m[0].replace(/[^\d]/g, '');
    return verhoeffValid(digits) ? '<AADHAAR>' : null;
  });

  replace(ACCOUNT_NEAR, 'ACCT', (m) => {
    const digits = m[1];
    return m[0].replace(digits, tokenFor('ACCT', digits));
  });

  replace(CARD_RUN, 'CARD', (m) => {
    const digits = m[0].replace(/[^\d]/g, '');
    if (!luhnValid(digits)) return null;
    // The last four identify which card without exposing the number, and the
    // Money Ledger's ownership guard needs them.
    return opts.keepCardTail === false ? '<CARD>' : `<CARD_****${digits.slice(-4)}>`;
  });

  replace(INDIAN_MOBILE, 'PHONE', (m) => tokenFor('PHONE', m[0].replace(/[^\d]/g, '').slice(-10)));

  // Addresses are identifying but the sender's domain is the single strongest
  // classification signal, so the local part is masked and the domain kept.
  replace(EMAIL_ADDR, 'EMAIL', (m) => {
    const [local, domain] = m[0].split('@');
    return `${tokenFor('EMAIL', local.toLowerCase())}@${domain}`;
  });

  return { text, redactions, blocked: false };
}

/** Put the real values back for display. The map never leaves this machine. */
export function rehydrate(text: string, redactions: Redaction[]): string {
  let out = text;
  for (const r of redactions) out = out.split(r.placeholder).join(r.original);
  return out;
}

/**
 * Trim to the part of a message that actually carries classification signal.
 * Marketing footers are long, uninformative and expensive; the top of a mail
 * is where the meaning is.
 */
export function truncateForModel(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n…[truncated]';
}
