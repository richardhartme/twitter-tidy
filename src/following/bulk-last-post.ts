import type { XClient } from '../auth/index.js';
import type { AccountProfile, Cache, InactivityOptions } from '../cache/index.js';
import { FetchError } from './fetch.js';
import { checkLastPost } from './last-post.js';
import { createRateLimiter, isAbort, pacedClient, type RateLimiter } from './rate-limiter.js';

/** How many of `accounts` a last-post check would call X for: stale, readable, and with posts. */
export function countLastPostFetches(cache: Cache, accounts: AccountProfile[], options: InactivityOptions = {}): number {
  return accounts.filter(
    (a) => !a.protected && !a.suspended && a.tweetCount !== 0 && cache.isStale(a.id, options),
  ).length;
}

export interface BulkLastPostProgress {
  /** Accounts checked so far. */
  done: number;
  total: number;
  /** API calls made so far. */
  fetched: number;
}

export interface BulkLastPostSummary extends BulkLastPostProgress {
  /** Recorded without a call (no posts). */
  recorded: number;
  /** Not checked: protected, suspended or still fresh. */
  skipped: number;
  /** Accounts whose answer couldn't be read; nothing was recorded for them. */
  failed: { handle: string; message: string }[];
  /** Whether the run was stopped before it checked every account. */
  cancelled: boolean;
}

export interface FetchLastPostsOptions extends InactivityOptions {
  client: XClient;
  cache: Cache;
  accounts: AccountProfile[];
  /** Paces the calls; defaults to a fresh one at X's 900 per 15 minutes. Share one across runs. */
  limiter?: RateLimiter;
  /** Stops the run after the account in progress; results so far are kept. */
  signal?: AbortSignal;
  onProgress?: (progress: BulkLastPostProgress) => void;
  /** Called before a wait, for the limiter or a 429, with when the run resumes (epoch milliseconds). */
  onRateLimit?: (resumeAt: number) => void;
}

/**
 * Checks the last post of each account in turn, recording each result as it arrives, so a stopped
 * run loses nothing and a rerun over the stale accounts carries on where it left off.
 */
export async function fetchLastPosts({
  client,
  cache,
  accounts,
  inactiveAfterMs,
  limiter = createRateLimiter(),
  signal,
  onProgress,
  onRateLimit,
}: FetchLastPostsOptions): Promise<BulkLastPostSummary> {
  const paced = pacedClient(client, limiter, { signal, onWait: onRateLimit });

  const summary: BulkLastPostSummary = {
    done: 0,
    total: accounts.length,
    fetched: 0,
    recorded: 0,
    skipped: 0,
    failed: [],
    cancelled: false,
  };
  for (const account of accounts) {
    if (signal?.aborted) break;
    try {
      const outcome = await checkLastPost({
        client: paced,
        cache,
        account,
        inactiveAfterMs,
        maxRateLimitWaits: Infinity,
        onRateLimit,
      });
      if (outcome.action === 'fetched') summary.fetched++;
      else if (outcome.action === 'recorded') summary.recorded++;
      else summary.skipped++;
    } catch (err) {
      if (isAbort(err)) break;
      if (!(err instanceof FetchError)) throw err;
      summary.failed.push({ handle: account.handle, message: err.message });
    }
    summary.done++;
    onProgress?.({ done: summary.done, total: summary.total, fetched: summary.fetched });
  }
  summary.cancelled = summary.done < summary.total;
  return summary;
}
