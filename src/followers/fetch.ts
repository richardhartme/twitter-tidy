import type { XClient } from '../auth/index.js';
import { fetchAllPages, type FetchListOptions } from '../following/index.js';

/**
 * Pulls the ids of every account that follows `userId`, page by page, waiting out rate limits however
 * long they last. Only ids are kept: followers are used solely to work out who follows back.
 */
export function fetchFollowers(client: XClient, userId: string, options: FetchListOptions = {}): Promise<string[]> {
  return fetchAllPages(client, {
    ...options,
    path: `/2/users/${encodeURIComponent(userId)}/followers`,
    what: 'your followers',
    map: (u: { id: string }) => u.id,
  });
}
