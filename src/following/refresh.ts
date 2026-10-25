import type { XClient } from '../auth/index.js';
import type { ApplyFollowingResult, Cache } from '../cache/index.js';
import { fetchFollowing, type FetchListOptions } from './fetch.js';

export interface RefreshSummary extends ApplyFollowingResult {
  /** Accounts followed after the refresh. */
  total: number;
  /** Accounts whose last post the pull dated (or found to have none). */
  lastPosts: number;
}

export interface RefreshFollowingOptions extends FetchListOptions {
  client: XClient;
  cache: Cache;
  userId: string;
}

/**
 * Pulls the complete Following list and applies it to the cache. The cache is only touched once every
 * page has arrived, so a failed pull never soft-removes the accounts on pages it didn't reach.
 */
export async function refreshFollowing({ client, cache, userId, ...options }: RefreshFollowingOptions): Promise<RefreshSummary> {
  const profiles = await fetchFollowing(client, userId, options);
  const lastPosts = profiles.filter((p) => p.lastPost).length;
  return { total: profiles.length, ...cache.applyFollowing(profiles), lastPosts };
}
