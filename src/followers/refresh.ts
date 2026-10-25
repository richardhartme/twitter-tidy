import type { XClient } from '../auth/index.js';
import type { Cache } from '../cache/index.js';
import type { FetchListOptions } from '../following/index.js';
import { fetchFollowers } from './fetch.js';

export interface FollowersSummary {
  /** Accounts following you after the refresh. */
  total: number;
  /** Accounts you follow that follow you back. */
  followBack: number;
  /** Accounts you follow that don't follow you back. */
  dontFollowBack: number;
}

export interface RefreshFollowersOptions extends FetchListOptions {
  client: XClient;
  cache: Cache;
  userId: string;
}

/**
 * Pulls the complete followers list and replaces the cached one. The cache is only touched once every
 * page has arrived, so a failed pull leaves follows-back exactly as it was (unknown if never pulled).
 */
export async function refreshFollowers({ client, cache, userId, ...options }: RefreshFollowersOptions): Promise<FollowersSummary> {
  const ids = await fetchFollowers(client, userId, options);
  cache.replaceFollowers(ids);
  const following = cache.listFollowing();
  const followBack = following.filter((a) => a.followsBack).length;
  return { total: cache.followerCount() ?? 0, followBack, dontFollowBack: following.length - followBack };
}
