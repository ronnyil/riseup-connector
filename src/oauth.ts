// Stateless OAuth 2.1 authorization server for claude.ai connectors.
//
// The user pastes their RiseUp PAT into a consent page once. Nothing is stored:
// client registrations, authorization codes, access and refresh tokens are all
// AES-256-GCM sealed blobs (encrypted + authenticated with TOKEN_ENCRYPTION_KEY)
// that carry the PAT inside them. Claude sends the access token as a Bearer
// header, so the PAT never appears in a URL.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

// Only Claude's own OAuth callbacks may receive codes. See
// https://support.claude.com/en/articles/11503834 (claude.com is the announced future URL).
export const ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
];

const CODE_TTL = 5 * 60;
const CONSENT_TTL = 10 * 60;
const ACCESS_TTL = 60 * 60;
const REFRESH_TTL = 30 * 24 * 60 * 60; // RiseUp PATs live at most 30 days anyway

type Sealed =
  | { typ: 'client'; info: Omit<OAuthClientInformationFull, 'client_id'> }
  | { typ: 'consent'; cid: string; ru: string; cc: string; st?: string; exp: number }
  | { typ: 'code'; pat: string; cid: string; ru: string; cc: string; exp: number }
  | { typ: 'access'; pat: string; cid: string; exp: number }
  | { typ: 'refresh'; pat: string; cid: string; exp: number };

const now = () => Math.floor(Date.now() / 1000);

export function parseKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('TOKEN_ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32)');
  return Buffer.from(hex, 'hex');
}

export class Sealer {
  constructor(private readonly key: Buffer) {}

  seal(payload: Sealed): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, ct, cipher.getAuthTag()]).toString('base64url');
  }

  /** Returns the payload if the blob is authentic, of the expected type and not expired. */
  open<T extends Sealed['typ']>(blob: string, typ: T): Extract<Sealed, { typ: T }> | null {
    try {
      const buf = Buffer.from(blob, 'base64url');
      if (buf.length < 12 + 16 + 1 || buf.length > 8192) return null;
      const decipher = createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
      decipher.setAuthTag(buf.subarray(buf.length - 16));
      const pt = Buffer.concat([decipher.update(buf.subarray(12, buf.length - 16)), decipher.final()]);
      const payload = JSON.parse(pt.toString('utf8')) as Sealed;
      if (payload.typ !== typ) return null;
      if ('exp' in payload && payload.exp < now()) return null;
      return payload as Extract<Sealed, { typ: T }>;
    } catch {
      return null;
    }
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const FORM_ACTION_ORIGINS = [...new Set(ALLOWED_REDIRECT_URIS.map((u) => new URL(u).origin))].join(' ');

export function renderConsent(res: Response, consent: string, redirectUri: string, error?: string): void {
  res.status(error ? 400 : 200).set({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // form-action must include Claude's origin: browsers apply it to the redirect after submit.
    'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${FORM_ACTION_ORIGINS}; frame-ancestors 'none'; base-uri 'none'`,
  }).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect RiseUp</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#111;background:#fff}
  @media (prefers-color-scheme:dark){body{color:#eee;background:#111}input{background:#222;color:#eee;border-color:#444}}
  input{width:100%;box-sizing:border-box;padding:.6rem;font:inherit;border:1px solid #bbb;border-radius:6px}
  button{margin-top:1rem;padding:.6rem 1.2rem;font:inherit;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
  .err{color:#dc2626} small{color:#777}
</style></head><body>
<h1>Connect RiseUp to Claude</h1>
<p>Paste your RiseUp Personal Access Token (scope <code>budget:read</code>). It is encrypted into the
credential Claude receives and is not stored on this server.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/consent" autocomplete="off">
  <input type="hidden" name="consent" value="${esc(consent)}">
  <label for="pat">Personal Access Token</label>
  <input id="pat" name="pat" type="password" placeholder="riseup_pat_..." required autofocus spellcheck="false">
  <button type="submit">Connect</button>
</form>
<p><small>You will be returned to ${esc(new URL(redirectUri).host)}. Create a token at
<a href="https://input.riseup.co.il/developer/tokens" target="_blank" rel="noopener noreferrer">input.riseup.co.il/developer/tokens</a>.</small></p>
</body></html>`);
}

export class StatelessProvider implements OAuthServerProvider {
  // Authorization codes are single-use: remember a digest of each redeemed code until it expires.
  private readonly usedCodes = new Map<string, number>();

  constructor(private readonly sealer: Sealer, private readonly patAllowed: (pat: string) => boolean) {}

  readonly clientsStore: OAuthRegisteredClientsStore = {
    getClient: (clientId) => {
      const c = this.sealer.open(clientId, 'client');
      return c ? { ...c.info, client_id: clientId } : undefined;
    },
    registerClient: (client) => {
      const uris = client.redirect_uris.map(String);
      if (uris.length === 0 || !uris.every((u) => ALLOWED_REDIRECT_URIS.includes(u))) {
        throw new InvalidClientMetadataError('redirect_uris must be Claude OAuth callback URLs');
      }
      // Keep only what the OAuth handlers need, so the sealed client_id stays small.
      const info = {
        redirect_uris: uris,
        token_endpoint_auth_method: client.token_endpoint_auth_method,
        grant_types: client.grant_types,
        response_types: client.response_types,
        client_name: client.client_name,
        client_secret: client.client_secret,
        client_secret_expires_at: client.client_secret_expires_at,
        client_id_issued_at: (client as Partial<OAuthClientInformationFull>).client_id_issued_at,
      };
      return { ...info, client_id: this.sealer.seal({ typ: 'client', info }) };
    },
  };

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const consent = this.sealer.seal({
      typ: 'consent', cid: client.client_id, ru: params.redirectUri, cc: params.codeChallenge,
      st: params.state, exp: now() + CONSENT_TTL,
    });
    renderConsent(res, consent, params.redirectUri);
  }

  /** POST /consent: the form submits the sealed request plus the PAT. */
  handleConsent(req: Request, res: Response, patRe: RegExp): void {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const consent = typeof body.consent === 'string' ? this.sealer.open(body.consent, 'consent') : null;
    if (!consent) {
      res.status(400).set('Cache-Control', 'no-store').type('text/plain').send('This sign-in link has expired. Start again from Claude.');
      return;
    }
    const pat = typeof body.pat === 'string' ? body.pat.trim() : '';
    if (!patRe.test(pat) || !this.patAllowed(pat)) {
      renderConsent(res, body.consent as string, consent.ru, 'That token was not accepted. Check that you copied the whole token.');
      return;
    }
    const code = this.sealer.seal({ typ: 'code', pat, cid: consent.cid, ru: consent.ru, cc: consent.cc, exp: now() + CODE_TTL });
    const target = new URL(consent.ru);
    target.searchParams.set('code', code);
    if (consent.st !== undefined) target.searchParams.set('state', consent.st);
    res.set('Cache-Control', 'no-store').redirect(302, target.href);
  }

  private openCode(client: OAuthClientInformationFull, code: string) {
    const c = this.sealer.open(code, 'code');
    if (!c || c.cid !== client.client_id) throw new InvalidGrantError('Invalid authorization code');
    return c;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.openCode(client, code).cc;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, _verifier?: string, redirectUri?: string): Promise<OAuthTokens> {
    const c = this.openCode(client, code);
    if (redirectUri !== undefined && redirectUri !== c.ru) throw new InvalidGrantError('redirect_uri mismatch');
    const t = now();
    for (const [k, exp] of this.usedCodes) if (exp < t) this.usedCodes.delete(k);
    const digest = createHash('sha256').update(code).digest('hex');
    if (this.usedCodes.has(digest)) throw new InvalidGrantError('Authorization code already used');
    this.usedCodes.set(digest, c.exp);
    if (!this.patAllowed(c.pat)) throw new InvalidGrantError('Token no longer allowed');
    return this.issue(c.pat, c.cid, t + REFRESH_TTL);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const r = this.sealer.open(refreshToken, 'refresh');
    if (!r || r.cid !== client.client_id || !this.patAllowed(r.pat)) throw new InvalidGrantError('Invalid refresh token');
    // Keep the original expiry: refreshing never extends the 30-day lifetime.
    return this.issue(r.pat, r.cid, r.exp);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const a = this.sealer.open(token, 'access');
    if (!a || !this.patAllowed(a.pat)) throw new InvalidTokenError('Invalid or expired access token');
    return { token, clientId: a.cid, scopes: [], expiresAt: a.exp, extra: { pat: a.pat } };
  }

  private issue(pat: string, cid: string, refreshExp: number): OAuthTokens {
    const exp = Math.min(now() + ACCESS_TTL, refreshExp);
    return {
      access_token: this.sealer.seal({ typ: 'access', pat, cid, exp }),
      token_type: 'Bearer',
      expires_in: exp - now(),
      refresh_token: this.sealer.seal({ typ: 'refresh', pat, cid, exp: refreshExp }),
    };
  }
}
