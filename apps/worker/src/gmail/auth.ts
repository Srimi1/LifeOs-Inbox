import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Google OAuth, dependency-free.
 *
 * Scopes are deliberately minimal: read Gmail, learn who you are, nothing else.
 * LifeOS cannot archive, label, send or delete — every piece of triage state
 * lives in our own database. A triage layer that cannot hurt you is one you
 * will give a chance to be wrong, and it keeps the blast radius at zero while
 * the classifier is still earning trust.
 *
 * No `gmail.modify`. No `gmail.send`. No Calendar (his is empty).
 */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'openid',
  'email',
];

const REDIRECT = 'http://localhost:8787/oauth/callback';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const TOKENS_PATH = fileURLToPath(new URL('../../../../.tokens.json', import.meta.url));

export interface StoredTokens {
  refresh_token: string;
  access_token?: string;
  /** Epoch ms. */
  expires_at?: number;
  email?: string;
}

export function loadTokens(): StoredTokens | null {
  if (!existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, 'utf8')) as StoredTokens;
  } catch {
    return null;
  }
}

export function saveTokens(t: StoredTokens): void {
  writeFileSync(TOKENS_PATH, JSON.stringify(t, null, 2) + '\n', { mode: 0o600 });
}

function creds(): { id: string; secret: string } {
  const id = process.env.GOOGLE_CLIENT_ID;
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error(
      'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set.\n' +
        'Copy .env.example to .env and fill them in — see docs/week-1-setup.md.',
    );
  }
  return { id, secret };
}

/**
 * One-time consent. Opens a local listener, prints the URL, waits for the code.
 *
 * The app is published to Production but unverified, so Google shows an
 * "unverified app" interstitial: click Advanced, then continue. That is
 * expected and it is what keeps the refresh token long-lived. Leaving the app
 * in Testing instead expires refresh tokens every 7 days, which would mean
 * silently dead sync every week — the exact failure the plan calls out as
 * worse than no product at all.
 */
export async function runConsentFlow(): Promise<StoredTokens> {
  const { id, secret } = creds();

  const url =
    `${AUTH_URL}?` +
    new URLSearchParams({
      client_id: id,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline',
      // Force a refresh token even if consent was granted before.
      prompt: 'consent',
    }).toString();

  console.log('\n  Open this URL and grant access:\n');
  console.log(`  ${url}\n`);
  console.log('  (Unverified-app screen → Advanced → Continue.)\n');

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://localhost:8787');
      if (u.pathname !== '/oauth/callback') {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get('error');
      const got = u.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:3rem">` +
          (got ? '<h2>Connected.</h2><p>You can close this tab.</p>' : `<h2>Failed</h2><p>${err}</p>`) +
          '</body>',
      );
      server.close();
      got ? resolve(got) : reject(new Error(err ?? 'no code returned'));
    });
    server.listen(8787);
    setTimeout(() => {
      server.close();
      reject(new Error('consent timed out after 5 minutes'));
    }, 300_000);
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: id,
      client_secret: secret,
      redirect_uri: REDIRECT,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as {
    refresh_token?: string;
    access_token: string;
    expires_in: number;
  };
  if (!json.refresh_token) {
    throw new Error(
      'Google returned no refresh_token. Revoke the app at ' +
        'https://myaccount.google.com/permissions and run auth again.',
    );
  }

  const tokens: StoredTokens = {
    refresh_token: json.refresh_token,
    access_token: json.access_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
  saveTokens(tokens);
  return tokens;
}

/** Exchange the stored refresh token for a live access token, with a 60s margin. */
export async function getAccessToken(): Promise<string> {
  const stored = loadTokens();
  if (!stored) throw new Error('Not connected. Run: npm run auth');

  if (stored.access_token && stored.expires_at && stored.expires_at - 60_000 > Date.now()) {
    return stored.access_token;
  }

  const { id, secret } = creds();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: stored.refresh_token,
      client_id: id,
      client_secret: secret,
      grant_type: 'refresh_token',
    }),
  });

  if (res.status === 400 || res.status === 401) {
    // invalid_grant: revoked, password changed, or the app slipped back to
    // Testing status. This is the silent-sync-death case, so it is loud.
    throw new Error(
      `[LifeOS ALERT] Gmail authorisation is dead (${res.status}). ` +
        'Re-run `npm run auth`. If this recurs weekly, the OAuth app is in ' +
        'Testing status — publish it to Production.',
    );
  }
  if (!res.ok) throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);

  const json = (await res.json()) as { access_token: string; expires_in: number };
  saveTokens({ ...stored, access_token: json.access_token, expires_at: Date.now() + json.expires_in * 1000 });
  return json.access_token;
}
