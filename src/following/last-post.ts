import type { RateLimitOptions, XClient } from '../auth/index.js';
import type { AccountProfile, Cache, InactivityOptions, LastPostResult } from '../cache/index.js';
import { formatDate } from '../format.js';
import { FetchError } from './fetch.js';
import { pacedClient, type RateLimiter } from './rate-limiter.js';

/** Posts read per last-post check (one timeline call); the newest is the last-post date. Any post counts. */
export const POSTS_PER_CHECK = 5;

/** `GET /2/users/:id/tweets` with `tweet.fields=created_at`. */
interface TimelinePage {
  data?: { created_at?: string }[];
  errors?: { title?: string; detail?: string; type?: string }[];
}

/**
 * The result a timeline response carries, or null when it is an error we can't classify. X reports
 * an account it won't show as an `errors` entry, with a 200 or an error status.
 */
function readTimeline(ok: boolean, page: TimelinePage): LastPostResult | null {
  const dates = (page.data ?? []).map((t) => Date.parse(t.created_at ?? '')).filter(Number.isFinite);
  if (dates.length > 0) return { status: 'ok', postedAt: Math.max(...dates) };
  const errors = page.errors ?? [];
  const says = (pattern: RegExp) => errors.some((e) => pattern.test(`${e.title} ${e.detail} ${e.type}`));
  if (says(/suspended/i)) return { status: 'suspended' };
  if (says(/not-authorized|not authorized|protected/i)) return { status: 'protected' };
  if (ok && errors.length === 0) return { status: 'no_posts' };
  return null;
}

/** What one last-post check did; only `fetched` made an API call. */
export type CheckLastPostOutcome =
  | { action: 'fetched'; result: LastPostResult }
  /** Recorded from the profile alone (`tweetCount` 0), without a call. */
  | { action: 'recorded'; result: { status: 'no_posts' } }
  /** Nothing recorded and no call: the account can't be read, or its cached date is still fresh. */
  | { action: 'skipped'; reason: 'protected' | 'suspended' | 'fresh' };

export interface CheckLastPostOptions extends RateLimitOptions, InactivityOptions {
  client: XClient;
  cache: Cache;
  account: AccountProfile;
}

/**
 * Checks one followed account's newest post and records it, calling X only when needed: never for
 * protected or suspended accounts, accounts with no posts, or cache entries that are still fresh.
 */
export async function checkLastPost({
  client,
  cache,
  account,
  inactiveAfterMs,
  maxRateLimitWaits,
  onRateLimit,
}: CheckLastPostOptions): Promise<CheckLastPostOutcome> {
  if (account.suspended) return { action: 'skipped', reason: 'suspended' };
  if (account.protected) return { action: 'skipped', reason: 'protected' };
  if (!cache.isStale(account.id, { inactiveAfterMs })) return { action: 'skipped', reason: 'fresh' };
  if (account.tweetCount === 0) {
    const result = { status: 'no_posts' } as const;
    cache.recordLastPost(account.id, result);
    return { action: 'recorded', result };
  }

  const params = new URLSearchParams({ max_results: String(POSTS_PER_CHECK), 'tweet.fields': 'created_at' });
  const res = await client.fetch(`/2/users/${encodeURIComponent(account.id)}/tweets?${params}`, undefined, {
    maxRateLimitWaits,
    onRateLimit,
  });
  const page = (await res.json().catch(() => ({}))) as TimelinePage;
  const result = readTimeline(res.ok, page);
  if (!result) throw new FetchError(`X returned ${res.status} while fetching @${account.handle}'s posts.`, res.status);
  cache.recordLastPost(account.id, result);
  return { action: 'fetched', result };
}

/** A one-line status-bar summary of a check. */
export function describeLastPostCheck(handle: string, outcome: CheckLastPostOutcome): string {
  const who = `@${handle}`;
  if (outcome.action === 'skipped') {
    return outcome.reason === 'fresh' ? `${who} is up to date; not fetched again` : `${who} is ${outcome.reason}; skipped`;
  }
  const { result } = outcome;
  switch (result.status) {
    case 'ok':
      return `${who} last posted ${formatDate(result.postedAt)}`;
    case 'no_posts':
      return `${who} has no posts`;
    case 'protected':
    case 'suspended':
      return `${who} is ${result.status}`;
  }
}

export interface FetchLastPostMessageOptions extends CheckLastPostOptions {
  /** Paces the call (and any retries) with the app's other timeline reads. */
  limiter: RateLimiter;
}

/** Checks one account's last tweet (`l`) and describes the outcome, or the failure, for the status bar. */
export async function fetchLastPostMessage({ client, limiter, account, ...options }: FetchLastPostMessageOptions): Promise<string> {
  try {
    return describeLastPostCheck(account.handle, await checkLastPost({ client: pacedClient(client, limiter), account, ...options }));
  } catch (err) {
    return `Couldn't fetch @${account.handle}'s last tweet: ${(err as Error).message}`;
  }
}
