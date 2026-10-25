import { openInBrowser } from '../browser.js';
import type { Config } from './config.js';
import { createXClient, type XClient } from './client.js';
import { login } from './login.js';
import { TokenStore } from './token-store.js';

/** Returns an authenticated client, logging in through the browser only if no tokens are stored. */
export async function connect(config: Config, store: TokenStore = new TokenStore()): Promise<XClient> {
  const deps = { fetch, now: Date.now, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
  let tokens = await store.load();
  if (!tokens) {
    tokens = await login(config, { ...deps, openBrowser: openInBrowser, log: console.error });
    await store.save(tokens);
  }
  return createXClient({ ...deps, config, store, tokens });
}

export { loadConfig } from './config.js';
export { AuthError, ConfigError } from './errors.js';
export type { RateLimitOptions, XClient } from './client.js';
