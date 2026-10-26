import type { XClient } from '../auth/index.js';
import type { AccountProfile, Cache } from '../cache/index.js';
import { createRateLimiter, pacedClient, type RateLimiter } from '../following/index.js';
import { UNFOLLOW_RATE_LIMIT, unfollowAccount, UnfollowError } from './unfollow.js';

export interface BulkUnfollowProgress {
  /** Accounts unfollowed so far. */
  done: number;
  total: number;
}

export interface BulkUnfollowSummary extends BulkUnfollowProgress {
  /** Whether the user stopped the run before it reached every account. */
  cancelled: boolean;
  /** What stopped the run early, if X refused or a call failed. */
  error: UnfollowError | null;
}

export interface UnfollowAccountsOptions {
  client: XClient;
  cache: Cache;
  /** The logged-in user's X id. */
  userId: string;
  accounts: AccountProfile[];
  /** Paces the calls; defaults to a fresh one at X's 50 per 15 minutes. Share the app's. */
  limiter?: RateLimiter;
  /** Stops the run after the account in progress; unfollows so far are kept. */
  signal?: AbortSignal;
  onProgress?: (progress: BulkUnfollowProgress) => void;
  /** Called before a wait, for the limiter or a 429, with when the run resumes (epoch milliseconds). */
  onRateLimit?: (resumeAt: number) => void;
}

const isAbort = (err: unknown) => err instanceof Error && err.name === 'AbortError';

/**
 * Unfollows each account in turn, recording each as it succeeds. The first refusal or failure stops
 * the run, so the accounts left are exactly those still followed, and running again carries on.
 */
export async function unfollowAccounts({
  client,
  cache,
  userId,
  accounts,
  limiter = createRateLimiter(UNFOLLOW_RATE_LIMIT),
  signal,
  onProgress,
  onRateLimit,
}: UnfollowAccountsOptions): Promise<BulkUnfollowSummary> {
  const paced = pacedClient(client, limiter, { signal, onWait: onRateLimit });
  const summary: BulkUnfollowSummary = { done: 0, total: accounts.length, cancelled: false, error: null };
  for (const account of accounts) {
    if (signal?.aborted) break;
    try {
      await unfollowAccount({ client: paced, cache, userId, account, maxRateLimitWaits: Infinity, onRateLimit });
    } catch (err) {
      if (isAbort(err)) break;
      if (!(err instanceof UnfollowError)) throw err;
      summary.error = err;
      break;
    }
    summary.done++;
    onProgress?.({ done: summary.done, total: summary.total });
  }
  summary.cancelled = summary.error === null && summary.done < summary.total;
  return summary;
}
