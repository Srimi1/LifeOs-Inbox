import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * Delivery, with a fallback that is not a stub.
 *
 * Email-to-self is the v1 push channel: zero new client infrastructure, works
 * on every device, and the brief is already an email artifact. Until a Resend
 * key exists the same rendered message is written to disk and printed, so the
 * pipeline is exercised end to end from day one rather than waiting on a
 * signup — and a failed send is reported rather than swallowed, because a
 * brief that silently stops arriving is indistinguishable from a quiet day.
 */
const OUT_DIR = fileURLToPath(new URL('../../../data/outbox', import.meta.url));

export interface Message {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type DeliveryResult =
  | { ok: true; via: 'resend'; id: string }
  | { ok: true; via: 'file'; path: string }
  | { ok: false; via: 'resend'; error: string };

export async function deliver(msg: Message): Promise<DeliveryResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.BRIEF_FROM ?? 'LifeOS <onboarding@resend.dev>';

  if (!key) return toFile(msg);

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    });
    if (!res.ok) {
      return { ok: false, via: 'resend', error: `${res.status} ${await res.text()}` };
    }
    const json = (await res.json()) as { id: string };
    return { ok: true, via: 'resend', id: json.id };
  } catch (err) {
    return { ok: false, via: 'resend', error: err instanceof Error ? err.message : String(err) };
  }
}

function toFile(msg: Message): DeliveryResult {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(OUT_DIR, `brief-${stamp}.html`);
  writeFileSync(path, msg.html);
  writeFileSync(path.replace(/\.html$/, '.txt'), `Subject: ${msg.subject}\n\n${msg.text}`);
  return { ok: true, via: 'file', path };
}
