import type { Category, Urgency, Action, Confidence, Method, ExtractKind } from './taxonomy.ts';

/**
 * The universal envelope. Everything downstream — rulepack, extractors,
 * modules, dashboard — reads a Signal and never the raw source payload.
 */
export interface Signal {
  /** Gmail message id, upload row hash, capture uuid. */
  externalId: string;
  /** Gmail threadId. Powers follow-up and reply-close detection. */
  threadKey?: string;
  kind: 'email' | 'manual_note' | 'statement_row';
  senderName?: string;
  senderAddr: string;
  /** Lowercased host of senderAddr. The rulepack's primary key. */
  senderDomain: string;
  toAddrs: string[];
  title: string;
  /** Subject + snippet + body text, already HTML-stripped. Extractors read this. */
  text: string;
  occurredAt: string;
  /** Gmail label ids. `SENT` here means it is outbound — follow-up seeding reads this. */
  labels: string[];
  headers?: Record<string, string>;
}

/**
 * An extraction that carries its own proof.
 *
 * `evidence` must appear verbatim in the source text at `offset`, or the
 * extraction is rejected as if the call had failed. This single rule kills the
 * entire "the model invented a due date" failure class, and it is what lets the
 * UI show the source string on hover for every rupee and every date on screen.
 */
export interface Extraction {
  kind: ExtractKind;
  valueText?: string;
  valueDate?: string;
  valueNum?: number;
  currency?: string;
  evidence: string;
  offset: number;
  method: Method;
  extractorVersion: string;
}

export interface Classification {
  category: Category;
  urgency: Urgency;
  action: Action;
  confidence: Confidence;
  method: Method;
  classifierVersion: string;
  /** Which rules fired, for the "why is this here?" affordance. */
  ruleIds: string[];
  /** True when a Tier-0 rule fully resolved it — no LLM call is needed. */
  skipLlm: boolean;
}

export interface TriagedSignal {
  signal: Signal;
  classification: Classification;
  extractions: Extraction[];
  /** Set when the ownership guard rejects a financial signal. */
  notYours?: { reason: string; evidence?: string };
}

const ANGLE = /<([^>]+)>/;

export function parseAddress(raw: string): { name?: string; addr: string; domain: string } {
  const trimmed = (raw ?? '').trim();
  const m = trimmed.match(ANGLE);
  const addr = (m ? m[1] : trimmed).trim().toLowerCase();
  const name = m ? trimmed.slice(0, m.index).trim().replace(/^"|"$/g, '') : undefined;
  const at = addr.lastIndexOf('@');
  return { name: name || undefined, addr, domain: at === -1 ? '' : addr.slice(at + 1) };
}

/** Collapse HTML and whitespace so extractor regexes see one clean line of text. */
export function toPlainText(input: string): string {
  return (input ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;|&#39;/g, "'")
    // Zero-width and soft-hyphen padding is used heavily by marketing mail to
    // defeat clipping; it also defeats naive regexes if left in.
    .replace(/[\u00AD\u200B-\u200F\u2028\u2029\uFEFF]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface RawEmail {
  id: string;
  threadId?: string;
  sender: string;
  toRecipients?: string[];
  subject?: string;
  snippet?: string;
  body?: string;
  date: string;
  labelIds?: string[];
  headers?: Record<string, string>;
}

export function normalizeEmail(raw: RawEmail): Signal {
  const { name, addr, domain } = parseAddress(raw.sender);
  const subject = toPlainText(raw.subject ?? '');
  const body = toPlainText(raw.body ?? raw.snippet ?? '');
  return {
    externalId: raw.id,
    threadKey: raw.threadId,
    kind: 'email',
    senderName: name,
    senderAddr: addr,
    senderDomain: domain,
    toAddrs: (raw.toRecipients ?? []).map((t) => parseAddress(t).addr),
    title: subject,
    text: `${subject}\n${body}`.trim(),
    occurredAt: raw.date,
    labels: raw.labelIds ?? [],
    headers: raw.headers,
  };
}
