import { describe, expect, test, vi } from 'vitest';
import { createXClient } from '../../src/auth/client.js';
import type { TokenStore, Tokens } from '../../src/auth/token-store.js';
import { openCache } from '../../src/cache/index.js';
import { FetchError, fetchFollowing, refreshFollowing } from '../../src/following/index.js';

const tokens: Tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 0, userId: '42', handle: 'me' };
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

/** A user as `GET /2/users/:id/following` returns it with the requested `user.fields`. */
const xUser = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  username: `user${id}`,
  name: `User ${id}`,
  description: `Bio ${id}`,
  location: 'Leeds',
  created_at: '2015-03-01T12:00:00.000Z',
  protected: false,
  verified: false,
  public_metrics: { followers_count: 10, following_count: 20, tweet_count: 30, listed_count: 1 },
  ...extra,
});

const users = (from: number, count: number) => Array.from({ length: count }, (_, i) => xUser(String(from + i)));

/** A real client over a fake fetch that answers from `responses` in order and records request URLs. */
function setup(responses: (Response | Error)[]) {
  const urls: URL[] = [];
  const f = vi.fn(async (url: string | URL | Request) => {
    urls.push(new URL(String(url)));
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    if (next instanceof Error) throw next;
    return next;
  });
  const sleep = vi.fn(async () => {});
  const client = createXClient({
    config: { clientId: 'cid', port: 1, redirectUri: 'http://127.0.0.1:1/callback' },
    store: { save: async () => {} } as unknown as TokenStore,
    tokens,
    fetch: f as never,
    now: () => 1_000_000,
    sleep,
  });
  return { client, urls, sleep, f };
}

describe('fetchFollowing', () => {
  test('follows next_token across pages and requests the profile fields', async () => {
    const { client, urls } = setup([
      json({ data: users(0, 1000), meta: { result_count: 1000, next_token: 'p2' } }),
      json({ data: users(1000, 1000), meta: { result_count: 1000, next_token: 'p3' } }),
      json({ data: users(2000, 340), meta: { result_count: 340 } }),
    ]);
    const onProgress = vi.fn();
    const profiles = await fetchFollowing(client, '42', { onProgress });

    expect(profiles).toHaveLength(2340);
    expect(urls.map((u) => u.pathname)).toEqual(Array(3).fill('/2/users/42/following'));
    expect(urls.map((u) => u.searchParams.get('pagination_token'))).toEqual([null, 'p2', 'p3']);
    for (const u of urls) {
      expect(u.searchParams.get('max_results')).toBe('1000');
      expect(u.searchParams.get('user.fields')?.split(',').sort()).toEqual(
        ['created_at', 'description', 'location', 'protected', 'public_metrics', 'verified'],
      );
      expect(u.searchParams.get('expansions')).toBe('most_recent_post_id');
    }
    expect(onProgress).toHaveBeenLastCalledWith({ pages: 3, accounts: 2340 });
  });

  test('maps an X user to an account profile', async () => {
    const { client } = setup([
      json({
        data: [
          xUser('1', { verified: true, protected: true }),
          { id: '2', username: 'bare', name: 'Bare', description: '' },
        ],
        meta: { result_count: 2 },
      }),
    ]);
    expect(await fetchFollowing(client, '42')).toEqual([
      {
        id: '1',
        handle: 'user1',
        name: 'User 1',
        bio: 'Bio 1',
        location: 'Leeds',
        createdAt: '2015-03-01T12:00:00.000Z',
        verified: true,
        protected: true,
        suspended: false,
        followersCount: 10,
        followingCount: 20,
        tweetCount: 30,
        lastPost: null,
      },
      {
        id: '2',
        handle: 'bare',
        name: 'Bare',
        bio: null,
        location: null,
        createdAt: null,
        verified: false,
        protected: false,
        suspended: false,
        followersCount: null,
        followingCount: null,
        tweetCount: null,
        lastPost: null,
      },
    ]);
  });

  test("reads each account's newest post date from its most recent post id", async () => {
    // Post ids are snowflakes: the top bits are milliseconds since X's epoch.
    const postedAt = Date.parse('2026-10-01T09:30:00.000Z');
    const { client } = setup([
      json({
        data: [
          xUser('1', { most_recent_post_id: '2105591045944246272' }),
          xUser('2', { most_recent_tweet_id: '2105591045944246272' }),
          xUser('3', { public_metrics: { tweet_count: 0 } }),
          xUser('4'),
          xUser('5', { protected: true, most_recent_post_id: '2105591045944246272' }),
          xUser('6', { most_recent_post_id: 'not-a-snowflake' }),
        ],
        meta: { result_count: 6 },
      }),
    ]);
    const lastPosts = (await fetchFollowing(client, '42')).map((a) => [a.id, a.lastPost]);
    expect(lastPosts).toEqual([
      ['1', { status: 'ok', postedAt }],
      ['2', { status: 'ok', postedAt }],
      // No post id and no posts: nothing to fetch later either.
      ['3', { status: 'no_posts' }],
      // Posts but no id returned: left for a timeline check.
      ['4', null],
      // Protected accounts keep their label and are never checked.
      ['5', null],
      ['6', null],
    ]);
  });

  test('a page with no data is an empty list', async () => {
    const { client } = setup([json({ meta: { result_count: 0 } })]);
    expect(await fetchFollowing(client, '42')).toEqual([]);
  });
});

describe('refreshFollowing', () => {
  const page = (ids: string[], next?: string) =>
    json({ data: ids.map((id) => xUser(id)), meta: { result_count: ids.length, ...(next && { next_token: next }) } });

  test('a second pull reports added, removed and restored accounts', async () => {
    const cache = openCache({ path: ':memory:' });
    const first = await refreshFollowing({ client: setup([page(['1', '2'], 'n'), page(['3'])]).client, cache, userId: '42' });
    expect(first).toEqual({ total: 3, added: ['1', '2', '3'], removed: [], restored: [], lastPosts: 0 });

    await refreshFollowing({ client: setup([page(['1', '3'])]).client, cache, userId: '42' });
    const third = await refreshFollowing({ client: setup([page(['1', '2', '4'])]).client, cache, userId: '42' });
    expect(third).toEqual({ total: 3, added: ['4'], removed: ['3'], restored: ['2'], lastPosts: 0 });
    expect(cache.listFollowing().map((a) => [a.id, a.isNew])).toEqual([['1', false], ['2', false], ['4', true]]);
  });

  test('records the last post dates the pull carried, as fresh checks', async () => {
    const cache = openCache({ path: ':memory:', now: () => 5_000 });
    const pull = json({
      data: [xUser('1', { most_recent_post_id: '2105591045944246272' }), xUser('2', { public_metrics: { tweet_count: 0 } }), xUser('3')],
      meta: { result_count: 3 },
    });
    const summary = await refreshFollowing({ client: setup([pull]).client, cache, userId: '42' });

    expect(summary.lastPosts).toBe(2);
    expect(cache.listFollowing().map((a) => [a.id, a.lastPost])).toEqual([
      ['1', { status: 'ok', postedAt: Date.parse('2026-10-01T09:30:00.000Z'), checkedAt: 5_000 }],
      ['2', { status: 'no_posts', postedAt: null, checkedAt: 5_000 }],
      ['3', null],
    ]);
    expect(cache.staleAccounts().map((a) => a.id)).toEqual(['3']);
  });

  test('a failed page leaves the cache unchanged', async () => {
    const cache = openCache({ path: ':memory:' });
    await refreshFollowing({ client: setup([page(['1', '2'])]).client, cache, userId: '42' });
    const before = cache.listFollowing();

    const failing = setup([page(['3'], 'n'), new Response(null, { status: 503 })]);
    await expect(refreshFollowing({ client: failing.client, cache, userId: '42' })).rejects.toThrow(FetchError);
    const offline = setup([page(['3'], 'n'), new TypeError('fetch failed')]);
    await expect(refreshFollowing({ client: offline.client, cache, userId: '42' })).rejects.toThrow('fetch failed');

    expect(cache.listFollowing()).toEqual(before);
    expect(cache.listRemoved()).toEqual([]);
  });

  test('waits out more than three rate limits in a row and completes', async () => {
    const cache = openCache({ path: ':memory:' });
    const limited = () => new Response(null, { status: 429, headers: { 'x-rate-limit-reset': '1900' } });
    const { client, sleep } = setup([page(['1'], 'n'), limited(), limited(), limited(), limited(), page(['2'])]);
    const onRateLimit = vi.fn();
    expect(await refreshFollowing({ client, cache, userId: '42', onRateLimit })).toMatchObject({ total: 2 });
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(onRateLimit).toHaveBeenCalledWith(1_900_000);
  });
});
