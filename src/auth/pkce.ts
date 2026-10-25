import { createHash, randomBytes } from 'node:crypto';
import { SCOPES, type Config } from './config.js';

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize';

const base64url = (buf: Buffer) => buf.toString('base64url');

export function generateVerifier(): string {
  return base64url(randomBytes(32));
}

export function challengeFor(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthorizeUrl(config: Config, challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}
