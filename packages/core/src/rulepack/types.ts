import type { Category, Urgency, Action } from '../taxonomy.ts';
import type { Signal } from '../signal.ts';

export interface Matcher {
  /** Full address, lowercased. The most precise match available. */
  fromExact?: string[];
  /**
   * Exact domain only. Deliberately NOT suffix matching: `hdfcbank.bank.in`
   * and `mailers.hdfcbank.bank.in` are different senders with opposite
   * meanings, and suffix matching would silently merge them.
   */
  fromDomain?: string[];
  /** Opt-in suffix matching for genuine sender families (`*.naukri.com`). */
  fromDomainSuffix?: string[];
  fromPattern?: RegExp;
  subject?: RegExp;
  text?: RegExp;
  /** Recipient pattern — only meaningful on outbound mail. */
  toPattern?: RegExp;
  /** true = must be outbound (SENT), false = must be inbound. */
  outbound?: boolean;
}

export interface RuleOutcome {
  category: Category;
  urgency?: Urgency;
  action?: Action;
  /** Named sender-specific parser to run for structured fields. */
  parser?: string;
  /** Safe to auto-archive: it will never need a decision. */
  archiveEligible?: boolean;
  /** Seed a tracked thread in the Follow-Up Desk. */
  opensLoop?: boolean;
  /** False when the rule labels but cannot fully resolve — sends it to Tier 1. */
  resolves?: boolean;
}

export interface Rule {
  id: string;
  note?: string;
  /** Higher wins. Ties break on declaration order. */
  priority: number;
  when: Matcher;
  then: RuleOutcome;
}

/**
 * A floor can only ever escalate urgency, never lower it.
 *
 * This is the asymmetry the whole product's trust depends on: a false urgent
 * costs a glance, a missed urgent costs the product. Floors fire regardless of
 * what the category rule decided, and regardless of what any model later says.
 */
export interface UrgencyFloor {
  id: string;
  note?: string;
  when: Matcher;
  floor: Urgency;
  action?: Action;
}

export function domainMatches(signalDomain: string, m: Matcher): boolean {
  if (m.fromDomain?.some((d) => signalDomain === d)) return true;
  if (m.fromDomainSuffix?.some((d) => signalDomain === d || signalDomain.endsWith('.' + d))) return true;
  return false;
}

export function matches(sig: Signal, m: Matcher): boolean {
  const isOutbound = sig.labels.includes('SENT');
  if (m.outbound === true && !isOutbound) return false;
  if (m.outbound === false && isOutbound) return false;

  const senderClauses = [m.fromExact, m.fromDomain, m.fromDomainSuffix, m.fromPattern].filter(Boolean);
  if (senderClauses.length) {
    const hit =
      (m.fromExact?.includes(sig.senderAddr) ?? false) ||
      domainMatches(sig.senderDomain, m) ||
      (m.fromPattern?.test(sig.senderAddr) ?? false);
    if (!hit) return false;
  }

  if (m.toPattern && !sig.toAddrs.some((t) => m.toPattern!.test(t))) return false;
  if (m.subject && !m.subject.test(sig.title)) return false;
  if (m.text && !m.text.test(sig.text)) return false;

  // A matcher with no clauses at all must never match everything.
  return Boolean(
    senderClauses.length || m.toPattern || m.subject || m.text || m.outbound !== undefined,
  );
}
