import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The card table is his, not ours.
 *
 * He runs gift-card arbitrage across four loyalty programmes; any reward table
 * this product maintained would be worse than the one already in his head, and
 * Indian reward rules churn constantly. One stale recommendation would poison
 * trust in the whole module for a gain he does not need.
 *
 * So LifeOS stores nothing about rewards and infers nothing. It reads a file he
 * edits and surfaces it at the moment of decision — his own knowledge, applied
 * consistently. Everything here is display-only.
 */
export interface CardRule {
  /** Free text he chooses: "dining", "amazon", "fuel", "online food". */
  category: string;
  cardLast4: string;
  note?: string;
}

export interface CardEntry {
  last4: string;
  label: string;
  issuer?: string;
  creditLimit?: number;
  statementDay?: number;
}

export interface CardTable {
  cards: CardEntry[];
  rules: CardRule[];
  /**
   * Set only when no cards.json exists at all, as distinct from one that
   * exists with no rules yet. Inverted deliberately so a table constructed in
   * code counts as configured by default — the safe reading.
   */
  unconfigured?: boolean;
}

const CARDS_PATH = fileURLToPath(new URL('../../../cards.json', import.meta.url));

export const EMPTY_TABLE: CardTable = { cards: [], rules: [], unconfigured: true };

export function loadCardTable(path: string = CARDS_PATH): CardTable {
  if (!existsSync(path)) return EMPTY_TABLE;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<CardTable>;
    return { cards: raw.cards ?? [], rules: raw.rules ?? [] };
  } catch {
    return EMPTY_TABLE;
  }
}

export interface CardAnswer {
  card?: CardEntry;
  rule?: CardRule;
  /** Why this answer, in his own words where he supplied them. */
  because: string;
}

/**
 * "Which card for X?" — a lookup, never an inference.
 *
 * If he has not written a rule for a category, the honest answer is that there
 * is no rule, not a guess dressed up as advice.
 */
export function whichCard(category: string, table: CardTable = loadCardTable()): CardAnswer {
  const q = category.trim().toLowerCase();
  if (!q) return { because: 'no category given' };

  const rule =
    table.rules.find((r) => r.category.toLowerCase() === q) ??
    table.rules.find((r) => q.includes(r.category.toLowerCase()) || r.category.toLowerCase().includes(q));

  if (!rule) {
    // Distinguish "you have not decided this yet" from "you have not set this
    // up" — telling him to create a file he already has is just noise.
    if (table.unconfigured) {
      return { because: 'no card table yet — copy cards.example.json to cards.json' };
    }
    return {
      because: table.rules.length
        ? `no rule for "${category}" yet — add one to cards.json`
        : `no rules in cards.json yet. Add one: {"category":"${category}","cardLast4":"9005"}`,
    };
  }

  const card = table.cards.find((c) => c.last4 === rule.cardLast4);
  return {
    card,
    rule,
    because: rule.note ?? `your rule: ${rule.category} → ····${rule.cardLast4}`,
  };
}

/** Cards worth watching for bills: whatever he has listed, plus any seen in mail. */
export function knownCardsFrom(table: CardTable, seenLast4: string[]): { last4: string; label?: string }[] {
  const map = new Map<string, { last4: string; label?: string }>();
  for (const c of table.cards) map.set(c.last4, { last4: c.last4, label: c.label });
  for (const l of seenLast4) if (!map.has(l)) map.set(l, { last4: l });
  return [...map.values()];
}
