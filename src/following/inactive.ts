import { DEFAULT_INACTIVITY_MS, type InactivityOptions, type LastPost } from '../cache/index.js';

/**
 * Whether an account counts as inactive: its newest post is older than the threshold, or it has
 * never posted. A post exactly at the threshold is still active (matching the cache's staleness
 * rules). Unknown is never inactive: never checked, protected, suspended, or an `ok` with no date.
 * `now` (epoch milliseconds) is when to measure from, defaulting to the current time.
 */
export function isInactive(
  lastPost: LastPost | null,
  { inactiveAfterMs = DEFAULT_INACTIVITY_MS, now = Date.now() }: InactivityOptions & { now?: number } = {},
): boolean {
  if (lastPost === null) return false;
  if (lastPost.status === 'no_posts') return true;
  if (lastPost.status !== 'ok' || lastPost.postedAt === null) return false;
  return lastPost.postedAt < now - inactiveAfterMs;
}
