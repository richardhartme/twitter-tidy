import type { Config } from './config.js';
import { TokenRequestError } from './errors.js';

const TOKEN_URL = 'https://api.x.com/2/oauth2/token';

export interface TokenGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

type Deps = { fetch: typeof fetch; now: () => number };

async function requestTokens(config: Config, deps: Deps, body: Record<string, string>): Promise<TokenGrant> {
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (config.clientSecret) {
    // Confidential client: authenticate with HTTP Basic.
    headers.Authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
  }
  const res = await deps.fetch(TOKEN_URL, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ ...body, client_id: config.clientId }).toString(),
  });
  if (!res.ok) {
    throw new TokenRequestError(`X token endpoint returned ${res.status}: ${await res.text()}`, res.status);
  }
  const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAt: deps.now() + json.expires_in * 1000,
  };
}

export const exchangeCode = (config: Config, deps: Deps, code: string, verifier: string) =>
  requestTokens(config, deps, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });

export const refreshTokens = (config: Config, deps: Deps, refreshToken: string) =>
  requestTokens(config, deps, { grant_type: 'refresh_token', refresh_token: refreshToken });
