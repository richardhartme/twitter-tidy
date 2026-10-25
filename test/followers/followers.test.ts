import { describe, expect, test, vi } from 'vitest';
import { createXClient } from '../../src/auth/client.js';
import type { TokenStore, Tokens } from '../../src/auth/token-store.js';
import { openCache, type AccountProfile, type Cache } from '../../src/cache/index.js';
import { fetchFollowers, refreshFollowers } from '../../src/followers/index.js';
import { FetchError } from '../../src/following/index.js';

const tokens: Tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: 0, userId: '42', handle: 'me' };
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

/** A user as `GET /2/users/:id/followers` returns it with no extra fields. */
const xUser = (id: string) => ({ id, username: `user${id}`, name: `User ${id}` });
const ids = (from: number, count: number) => Array.from({ length: count }, (_, i) => String(from + i));
const page = (pageIds: string[], next?: string) =>
  json({ data: pageIds.map(xUser), meta: { result_count: pageIds.length, ...(next && { next_token: next }) } });

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

describe('fetchFollowers', () => {
  test('follows next_token across pages, 1000 at a time, and returns the follower ids', async () => {
    const { client, urls } = setup([page(ids(0, 1000), 'p2'), page(ids(1000, 1000), 'p3'), page(ids(2000, 5))]);
    const onProgress = vi.fn();
    const result = await fetchFollowers(client, '42', { onProgress });

    expect(result).toHaveLength(2005);
    expect(result.slice(0, 2)).toEqual(['0', '1']);
    expect(result.at(-1)).toBe('2004');
    expect(urls.map((u) => u.pathname)).toEqual(Array(3).fill('/2/users/42/followers'));
    expect(urls.map((u) => u.searchParams.get('pagination_token'))).toEqual([null, 'p2', 'p3']);
    for (const u of urls) expect(u.searchParams.get('max_results')).toBe('1000');
    expect(onProgress).toHaveBeenLastCalledWith({ pages: 3, accounts: 2005 });
  });

  test('a page with no data is an empty list', async () => {
    const { client } = setup([json({ meta: { result_count: 0 } })]);
    expect(await fetchFollowers(client, '42')).toEqual([]);
  });
});

describe('refreshFollowers', () => {
  const profile = (id: string): AccountProfile => ({
    id,
    handle: `user${id}`,
    name: `User ${id}`,
    bio: null,
    location: null,
    createdAt: null,
    verified: false,
    protected: false,
    suspended: false,
    followersCount: null,
    followingCount: null,
    tweetCount: null,
  });
  /** A cache following accounts 1 to 4. */
  const following = () => {
    const cache = openCache({ path: ':memory:' });
    cache.applyFollowing(['1', '2', '3', '4'].map(profile));
    return cache;
  };
  const followsBack = (cache: Cache) => cache.listFollowing().map((a) => [a.id, a.followsBack]);

  test('follows-back is unknown for every account before the first pull', () => {
    expect(followsBack(following())).toEqual([
      ['1', null],
      ['2', null],
      ['3', null],
      ['4', null],
    ]);
  });

  test('marks who follows back across pages and reports the counts', async () => {
    const cache = following();
    // Followers 2 and 4 are followed; 900 and 901 follow but aren't followed.
    const { client } = setup([page(['900', '2'], 'n'), page(['4', '901'])]);
    expect(await refreshFollowers({ client, cache, userId: '42' })).toEqual({
      total: 4,
      followBack: 2,
      dontFollowBack: 2,
    });
    expect(followsBack(cache)).toEqual([
      ['1', false],
      ['2', true],
      ['3', false],
      ['4', true],
    ]);
    expect(cache.followerCount()).toBe(4);
  });

  test('a second pull replaces the first', async () => {
    const cache = following();
    await refreshFollowers({ client: setup([page(['1', '2'])]).client, cache, userId: '42' });
    await refreshFollowers({ client: setup([page(['3'])]).client, cache, userId: '42' });
    expect(followsBack(cache)).toEqual([
      ['1', false],
      ['2', false],
      ['3', true],
      ['4', false],
    ]);
  });

  test('a failed page leaves follows-back unknown before the first pull, and unchanged after it', async () => {
    const cache = following();
    const failing = setup([page(['1'], 'n'), new Response(null, { status: 503 })]);
    await expect(refreshFollowers({ client: failing.client, cache, userId: '42' })).rejects.toThrow(FetchError);
    expect(followsBack(cache).every(([, back]) => back === null)).toBe(true);
    expect(cache.followerCount()).toBeNull();

    await refreshFollowers({ client: setup([page(['2'])]).client, cache, userId: '42' });
    const before = followsBack(cache);
    const offline = setup([page(['1', '3'], 'n'), new TypeError('fetch failed')]);
    await expect(refreshFollowers({ client: offline.client, cache, userId: '42' })).rejects.toThrow('fetch failed');
    expect(followsBack(cache)).toEqual(before);
  });

  test('waits out more than three rate limits in a row and completes', async () => {
    const cache = following();
    const limited = () => new Response(null, { status: 429, headers: { 'x-rate-limit-reset': '1900' } });
    const { client, sleep } = setup([page(['1'], 'n'), limited(), limited(), limited(), limited(), page(['2'])]);
    const onRateLimit = vi.fn();
    expect(await refreshFollowers({ client, cache, userId: '42', onRateLimit })).toMatchObject({ total: 2 });
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(onRateLimit).toHaveBeenCalledWith(1_900_000);
  });
});
