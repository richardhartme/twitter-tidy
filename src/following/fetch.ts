import type { RateLimitOptions, XClient } from '../auth/index.js';
import type { AccountProfile, LastPostResult, PulledAccount } from '../cache/index.js';

const PAGE_SIZE = 1000;
const USER_FIELDS = 'created_at,description,location,protected,public_metrics,verified';
/** Adds each account's newest post id to the pull, so one refresh also dates every last post. */
const EXPANSIONS = 'most_recent_post_id';
/** Milliseconds since 1970 at X's snowflake epoch; a post id's top bits count from here. */
const SNOWFLAKE_EPOCH = 1288834974657n;

/** A user as `GET /2/users/:id/following` returns it with `USER_FIELDS`. */
interface XUser {
  id: string;
  username: string;
  name: string;
  description?: string;
  location?: string;
  created_at?: string;
  protected?: boolean;
  verified?: boolean;
  public_metrics?: { followers_count?: number; following_count?: number; tweet_count?: number };
  most_recent_post_id?: string;
  /** The field's older name, in case the API still answers with it. */
  most_recent_tweet_id?: string;
}

/** One page of a paginated X list. */
interface Page<T> {
  data?: T[];
  meta?: { next_token?: string };
}

export interface FetchProgress {
  pages: number;
  accounts: number;
}

/** Options for pulling a complete paginated list (Following or followers). */
export interface FetchListOptions {
  onProgress?: (progress: FetchProgress) => void;
  onRateLimit?: RateLimitOptions['onRateLimit'];
}

/** The X API answered with an error status. */
export class FetchError extends Error {
  override name = 'FetchError';
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const toProfile = (u: XUser): AccountProfile => ({
  id: u.id,
  handle: u.username,
  name: u.name,
  bio: u.description || null,
  location: u.location || null,
  createdAt: u.created_at ?? null,
  verified: u.verified ?? false,
  protected: u.protected ?? false,
  // Following never returns suspended accounts.
  suspended: false,
  followersCount: u.public_metrics?.followers_count ?? null,
  followingCount: u.public_metrics?.following_count ?? null,
  tweetCount: u.public_metrics?.tweet_count ?? null,
});

/** When a post was created, from its snowflake id; null if the id isn't one. */
export function postedAtFromId(id: string): number | null {
  if (!/^\d+$/.test(id)) return null;
  return Number((BigInt(id) >> 22n) + SNOWFLAKE_EPOCH);
}

/** The newest post a Following pull tells us about, or null when a timeline check must decide. */
function lastPostOf(u: XUser, profile: AccountProfile): LastPostResult | null {
  // Protected accounts keep their label; their posts are never read.
  if (profile.protected) return null;
  const id = u.most_recent_post_id ?? u.most_recent_tweet_id;
  const postedAt = id ? postedAtFromId(id) : null;
  if (postedAt !== null) return { status: 'ok', postedAt };
  if (!id && profile.tweetCount === 0) return { status: 'no_posts' };
  return null;
}

const toPulledAccount = (u: XUser): PulledAccount => {
  const profile = toProfile(u);
  return { ...profile, lastPost: lastPostOf(u, profile) };
};

export interface FetchAllPagesOptions<Item, T> extends FetchListOptions {
  /** The list's path, e.g. `/2/users/42/following`. */
  path: string;
  /** Query parameters sent with every page, besides `max_results` and the page token. */
  params?: Record<string, string>;
  /** What the list is, for the error message (e.g. "your Following list"). */
  what: string;
  /** Converts one returned item. */
  map: (item: Item) => T;
}

/**
 * Pulls every item of a paginated X list, page by page, waiting out rate limits however long they
 * last. Throws a `FetchError` on any error status.
 */
export async function fetchAllPages<Item, T>(
  client: XClient,
  { path, params: extra = {}, what, map, onProgress, onRateLimit }: FetchAllPagesOptions<Item, T>,
): Promise<T[]> {
  const items: T[] = [];
  let pages = 0;
  let token: string | undefined;
  do {
    const params = new URLSearchParams({ max_results: String(PAGE_SIZE), ...extra });
    if (token) params.set('pagination_token', token);
    const res = await client.fetch(`${path}?${params}`, undefined, { maxRateLimitWaits: Infinity, onRateLimit });
    if (!res.ok) throw new FetchError(`X returned ${res.status} while fetching ${what}.`, res.status);
    const page = (await res.json()) as Page<Item>;
    items.push(...(page.data ?? []).map(map));
    onProgress?.({ pages: ++pages, accounts: items.length });
    token = page.meta?.next_token;
  } while (token);
  return items;
}

/**
 * Pulls every account `userId` follows, page by page, waiting out rate limits however long they last.
 * Each account carries its newest post when X returns one.
 */
export function fetchFollowing(client: XClient, userId: string, options: FetchListOptions = {}): Promise<PulledAccount[]> {
  return fetchAllPages(client, {
    ...options,
    path: `/2/users/${encodeURIComponent(userId)}/following`,
    params: { 'user.fields': USER_FIELDS, expansions: EXPANSIONS },
    what: 'your Following list',
    map: toPulledAccount,
  });
}
