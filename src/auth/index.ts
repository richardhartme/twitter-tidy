import { openInBrowser } from '../browser.js';
import { SCOPES, type Config } from './config.js';
import { createXClient, type XClient } from './client.js';
import { login } from './login.js';
import { TokenStore, type Tokens } from './token-store.js';

export interface ConnectOptions {
  /** The interactive browser login; injectable for tests. */
  signIn?: (config: Config) => Promise<Tokens>;
}

/** Whether saved tokens were granted every scope the app asks for. */
const hasEveryScope = (tokens: Tokens) => SCOPES.every((s) => tokens.scopes?.includes(s));

/**
 * Returns an authenticated client, logging in through the browser only if no tokens are stored or
 * they lack a scope the app now asks for (e.g. `follows.write`, added for unfollowing).
 */
export async function connect(
  config: Config,
  store: TokenStore = new TokenStore(),
  { signIn }: ConnectOptions = {},
): Promise<XClient> {
  const deps = { fetch, now: Date.now, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
  let tokens = await store.load();
  if (!tokens || !hasEveryScope(tokens)) {
    if (tokens) console.error('TwitterTidy needs permission to unfollow, so you need to log in to X again.');
    tokens = await (signIn ?? ((c) => login(c, { ...deps, openBrowser: openInBrowser, log: console.error })))(config);
    await store.save(tokens);
  }
  return createXClient({ ...deps, config, store, tokens });
}

export { loadConfig } from './config.js';
export { AuthError, ConfigError } from './errors.js';
export type { RateLimitOptions, XClient } from './client.js';
