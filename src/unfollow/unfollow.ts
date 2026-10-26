import type { RateLimitOptions, XClient } from '../auth/index.js';
import type { AccountProfile, Cache } from '../cache/index.js';
import { isAbort, type RateLimiter } from '../following/index.js';
import { clockTime } from '../format.js';

/** X's per-user limit on unfollows: 50 requests per 15 minutes. */
export const UNFOLLOW_RATE_LIMIT = { limit: 50, windowMs: 15 * 60_000 } as const;

/** Why an unfollow didn't happen. `rate-limited`: the limit is used up until `resetAt`; `failed`: anything else. */
export type UnfollowErrorKind = 'rate-limited' | 'failed';

export class UnfollowError extends Error {
  override name = 'UnfollowError';
  constructor(
    message: string,
    readonly kind: UnfollowErrorKind,
    /** When the rate limit resets (epoch milliseconds); set only for `rate-limited`. */
    readonly resetAt?: number,
  ) {
    super(message);
  }
}

export interface UnfollowAccountOptions extends RateLimitOptions {
  client: XClient;
  cache: Cache;
  /** The logged-in user's X id. */
  userId: string;
  account: AccountProfile;
}

/** X's explanation in an error body, if it gives one. */
const reason = (body: { detail?: string; title?: string; errors?: { detail?: string; title?: string }[] }) =>
  body.detail ?? body.errors?.[0]?.detail ?? body.title ?? body.errors?.[0]?.title;

/**
 * Unfollows one account and records it in the cache. An account X no longer knows (404) counts as
 * unfollowed; anything else that isn't a success throws an `UnfollowError` and records nothing.
 */
export async function unfollowAccount({
  client,
  cache,
  userId,
  account,
  ...rateLimitOptions
}: UnfollowAccountOptions): Promise<void> {
  const who = `@${account.handle}`;
  let res: Response;
  try {
    res = await client.fetch(
      `/2/users/${encodeURIComponent(userId)}/following/${encodeURIComponent(account.id)}`,
      { method: 'DELETE' },
      rateLimitOptions,
    );
  } catch (err) {
    // A stopped run's wait for the limiter: leave it for the caller to treat as stopped.
    if (isAbort(err)) throw err;
    throw new UnfollowError(`Couldn't unfollow ${who}: ${(err as Error).message}`, 'failed');
  }
  if (res.ok || res.status === 404) {
    cache.recordUnfollow(account.id);
    return;
  }
  if (res.status === 429) {
    const header = Number(res.headers.get('x-rate-limit-reset')) * 1000;
    const resetAt = Number.isFinite(header) && header > 0 ? header : undefined;
    throw new UnfollowError(`X's unfollow limit is used up.`, 'rate-limited', resetAt);
  }
  const why = reason((await res.json().catch(() => ({}))) as Parameters<typeof reason>[0]);
  if (res.status === 403) {
    throw new UnfollowError(
      `X refused to unfollow ${who}${why ? `: ${why}` : ''}. Check your X app has Read and write permission and your plan allows unfollowing.`,
      'failed',
    );
  }
  throw new UnfollowError(`X returned ${res.status} while unfollowing ${who}${why ? `: ${why}` : ''}.`, 'failed');
}

export interface UnfollowMessageOptions extends Omit<UnfollowAccountOptions, keyof RateLimitOptions> {
  /** The app's unfollow limiter; a single unfollow never waits for it. */
  limiter: RateLimiter;
}

/** Unfollows one account (`u`) at once, or refuses if the limit is used up, and describes the outcome for the status bar. */
export async function unfollowMessage({ limiter, account, ...options }: UnfollowMessageOptions): Promise<string> {
  const tryAgain = (at: number | undefined) => (at ? `; try again at ${clockTime(at)}` : '');
  const resumeAt = limiter.tryAcquire();
  if (resumeAt !== null) return `Unfollow limit reached${tryAgain(resumeAt)}`;
  try {
    await unfollowAccount({ ...options, account, maxRateLimitWaits: 0 });
    return `Unfollowed @${account.handle}`;
  } catch (err) {
    if (!(err instanceof UnfollowError)) throw err;
    return err.kind === 'rate-limited' ? `${err.message.replace(/\.$/, '')}${tryAgain(err.resetAt)}` : err.message;
  }
}
