import type { Extraction } from '../signal.ts';
import type { ExtractKind } from '../taxonomy.ts';

/**
 * Build an extraction and prove it.
 *
 * The evidence string is re-checked against the source before the extraction is
 * allowed to exist. If a caller ever hands us a span that is not verbatim in the
 * text, we return null rather than a plausible-looking value — a rejected
 * extraction routes the signal to review, which is always recoverable, while a
 * fabricated due date is not.
 */
export function evidenced(
  text: string,
  kind: ExtractKind,
  evidence: string,
  offset: number,
  fields: Partial<Extraction>,
  extractorVersion: string,
): Extraction | null {
  if (!evidence) return null;
  if (text.slice(offset, offset + evidence.length) !== evidence) {
    const found = text.indexOf(evidence);
    if (found === -1) return null;
    offset = found;
  }
  return {
    kind,
    evidence,
    offset,
    method: 'rule',
    extractorVersion,
    ...fields,
  };
}

/** Deduplicate by (kind, value) keeping the earliest, most-specific evidence. */
export function dedupeExtractions(list: Extraction[]): Extraction[] {
  const seen = new Map<string, Extraction>();
  for (const e of list) {
    const key = `${e.kind}:${e.valueNum ?? ''}:${e.valueDate ?? ''}:${e.valueText ?? ''}`;
    const prev = seen.get(key);
    if (!prev || e.evidence.length > prev.evidence.length) seen.set(key, e);
  }
  return [...seen.values()].sort((a, b) => a.offset - b.offset);
}

/** Run a global regex and hand each match to a builder, dropping the rejects. */
export function scan(
  text: string,
  re: RegExp,
  build: (m: RegExpExecArray) => Extraction | null,
): Extraction[] {
  const out: Extraction[] = [];
  const rx = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = rx.exec(text)) !== null && guard++ < 500) {
    if (m[0] === '') { rx.lastIndex++; continue; }
    const built = build(m);
    if (built) out.push(built);
  }
  return out;
}
