import { getAccessToken } from './auth.ts';
import type { RawEmail } from '../../../../packages/core/src/signal.ts';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

/**
 * Gmail REST, dependency-free.
 *
 * Quota costs: messages.list = 5 units, messages.get = 5, history.list = 2,
 * against a budget of 15,000 units per user per minute. At one mailbox polled
 * every five minutes this uses a rounding error of the allowance, which is why
 * polling beats Pub/Sub push here — push would add a public webhook and a
 * 7-day watch renewal to save latency a single user will never notice.
 */
async function call<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const token = await getAccessToken();
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][],
  );
  const url = `${BASE}${path}${qs.toString() ? `?${qs}` : ''}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (res.ok) return (await res.json()) as T;

    // 429/5xx are transient. Back off with jitter rather than hammering, which
    // is what turns a rate limit into a stalled pipeline.
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Math.min(2 ** attempt * 500, 16_000) + Math.random() * 400;
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    throw new Error(`gmail ${path} → ${res.status} ${await res.text()}`);
  }
}

interface GmailPayloadPart {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; size?: number };
  parts?: GmailPayloadPart[];
  headers?: { name: string; value: string }[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPayloadPart;
}

function header(msg: GmailMessage, name: string): string | undefined {
  return msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

function decode(data?: string): string {
  if (!data) return '';
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

/** Prefer text/plain; fall back to the first text/html part. Attachments are never fetched. */
function bodyOf(part?: GmailPayloadPart): string {
  if (!part) return '';
  if (part.filename) return '';
  if (part.mimeType === 'text/plain') return decode(part.body?.data);
  if (part.parts?.length) {
    const plain = part.parts.map(bodyOf).find((t) => t.trim());
    if (plain) return plain;
  }
  if (part.mimeType === 'text/html') return decode(part.body?.data);
  return decode(part.body?.data);
}

export function toRawEmail(msg: GmailMessage): RawEmail {
  return {
    id: msg.id,
    threadId: msg.threadId,
    sender: header(msg, 'From') ?? '',
    toRecipients: (header(msg, 'To') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    subject: header(msg, 'Subject') ?? '',
    snippet: msg.snippet,
    body: bodyOf(msg.payload),
    date: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : (header(msg, 'Date') ?? new Date().toISOString()),
    labelIds: msg.labelIds ?? [],
    headers: {
      'content-type': header(msg, 'Content-Type') ?? '',
      'list-unsubscribe': header(msg, 'List-Unsubscribe') ?? '',
    },
  };
}

export async function getMessage(id: string): Promise<RawEmail> {
  return toRawEmail(await call<GmailMessage>(`/messages/${id}`, { format: 'full' }));
}

export async function getProfile(): Promise<{ emailAddress: string; historyId: string }> {
  return call<{ emailAddress: string; historyId: string }>('/profile');
}

/**
 * List message ids matching a query, paging until exhausted or `max` is hit.
 * The cap matters: a naive backfill over a 50,000-message mailbox would burn
 * quota and LLM budget on mail that is years stale.
 */
export async function listMessageIds(query: string, max = 2000): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await call<{ messages?: { id: string }[]; nextPageToken?: string }>('/messages', {
      q: query,
      maxResults: '500',
      pageToken,
    });
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

export interface HistoryPage {
  messageIds: string[];
  historyId?: string;
  /** True when the cursor was too old and a windowed re-scan is required. */
  expired: boolean;
}

/**
 * Incremental sync. A stored historyId is valid for roughly a week; when Gmail
 * rejects it with 404 we fall back to a dated query rather than replaying the
 * whole mailbox. Every downstream write is keyed on the message id, so a
 * re-scan is a no-op rather than a duplicate.
 */
export async function listHistorySince(startHistoryId: string): Promise<HistoryPage> {
  try {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    let latest = startHistoryId;
    do {
      const page = await call<{
        history?: { messagesAdded?: { message: { id: string } }[] }[];
        historyId?: string;
        nextPageToken?: string;
      }>('/history', {
        startHistoryId,
        historyTypes: 'messageAdded',
        maxResults: '500',
        pageToken,
      });
      for (const h of page.history ?? []) {
        for (const a of h.messagesAdded ?? []) ids.add(a.message.id);
      }
      latest = page.historyId ?? latest;
      pageToken = page.nextPageToken;
    } while (pageToken);
    return { messageIds: [...ids], historyId: latest, expired: false };
  } catch (err) {
    if (err instanceof Error && / 404 /.test(err.message)) {
      return { messageIds: [], expired: true };
    }
    throw err;
  }
}
