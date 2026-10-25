import type { Config } from './config.js';
import { AuthError } from './errors.js';
import { refreshTokens } from './token-request.js';
import type { TokenStore, Tokens } from './token-store.js';

const API_BASE = 'https://api.x.com';
const MAX_RATE_LIMIT_RETRIES = 3;

export interface XClientDeps {
  config: Config;
  store: TokenStore;
  tokens: Tokens;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface RateLimitOptions {
  /** How many 429s to wait out before returning one (default 3); `Infinity` never gives up. */
  maxRateLimitWaits?: number;
  /** Called before each wait with the reset time (epoch milliseconds). */
  onRateLimit?: (resetAt: number) => void;
  /** Awaited before each retry, after a 429 or a 401 refresh (e.g. to take a rate-limiter slot). */
  beforeRetry?: () => Promise<void>;
}

export interface XClient {
  /** Fetch an X API path (e.g. `/2/users/me`) with auth, 401-refresh and 429-wait handling. */
  fetch(path: string, init?: RequestInit, options?: RateLimitOptions): Promise<Response>;
  readonly tokens: Tokens;
}

export function createXClient(deps: XClientDeps): XClient {
  let tokens = deps.tokens;

  const send = (path: string, init: RequestInit | undefined) => {
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${tokens.accessToken}`);
    return deps.fetch(`${API_BASE}${path}`, { ...init, headers });
  };

  async function refresh(): Promise<void> {
    try {
      const grant = await refreshTokens(deps.config, deps, tokens.refreshToken);
      tokens = { ...tokens, ...grant };
      await deps.store.save(tokens);
    } catch (err) {
      throw new AuthError(`Your X session could not be refreshed; log in again. (${(err as Error).message})`);
    }
  }

  return {
    get tokens() {
      return tokens;
    },
    async fetch(path, init, { maxRateLimitWaits = MAX_RATE_LIMIT_RETRIES, onRateLimit, beforeRetry } = {}) {
      let refreshed = false;
      let waits = 0;
      for (let attempt = 0; ; attempt++) {
        if (attempt > 0) await beforeRetry?.();
        const res = await send(path, init);
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          await refresh();
          continue;
        }
        if (res.status === 429 && waits < maxRateLimitWaits) {
          waits++;
          const headerMs = Number(res.headers.get('x-rate-limit-reset')) * 1000;
          const resetAt = Number.isFinite(headerMs) && headerMs > 0 ? headerMs : deps.now();
          onRateLimit?.(resetAt);
          await deps.sleep(Math.max(0, resetAt - deps.now()) + 1000);
          continue;
        }
        return res;
      }
    },
  };
}
