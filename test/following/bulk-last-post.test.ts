import { describe, expect, test, vi } from 'vitest';
import type { XClient } from '../../src/auth/index.js';
import { openCache, type AccountProfile } from '../../src/cache/index.js';
import { countLastPostFetches, createRateLimiter, fetchLastPosts } from '../../src/following/index.js';

const DAY = 86_400_000;
const NOW = 2_000 * DAY;
const POSTED = '2026-03-04T09:00:00.000Z';

const profile = (id: string, extra: Partial<AccountProfile> = {}): AccountProfile => ({
  id,
  handle: `user${id}`,
  name: `User ${id}`,
  bio: null,
  location: null,
  createdAt: null,
  verified: false,
  protected: false,
  suspended: false,
  followersCount: 10,
  followingCount: 20,
  tweetCount: 30,
  ...extra,
});

const tweets = () => new Response(JSON.stringify({ data: [{ id: '1', text: 't', created_at: POSTED }] }));

/** A cache following `accounts`, a fake client that answers every timeline read, and a fake clock. */
function setup(accounts: AccountProfile[]) {
  let t = NOW;
  const clock = {
    now: () => t,
    sleep: vi.fn(async (ms: number) => {
      t += ms;
    }),
  };
  const cache = openCache({ path: ':memory:', now: clock.now });
  cache.applyFollowing(accounts);
  const fetch = vi.fn(async (_path: string, _init?: RequestInit, _options?: unknown) => tweets());
  const client = { fetch, tokens: {} } as unknown as XClient;
  const fetchedIds = () => fetch.mock.calls.map(([path]) => /\/2\/users\/([^/]+)\/tweets/.exec(path)![1]);
  const lastPost = (id: string) => cache.listFollowing().find((a) => a.id === id)?.lastPost?.status ?? null;
  return { cache, client, fetch, clock, fetchedIds, lastPost };
}

describe('countLastPostFetches', () => {
  test('counts only stale accounts that need a call', () => {
    const accounts = [
      profile('1'),
      profile('2'),
      profile('p', { protected: true }),
      profile('s', { suspended: true }),
      profile('0', { tweetCount: 0 }),
      profile('f'),
    ];
    const { cache } = setup(accounts);
    cache.recordLastPost('f', { status: 'ok', postedAt: NOW - DAY }); // fresh
    expect(countLastPostFetches(cache, accounts)).toBe(2);
    expect(countLastPostFetches(cache, cache.staleAccounts())).toBe(2);
  });

  test('uses the given inactivity threshold', () => {
    const accounts = [profile('1')];
    const { cache, clock } = setup(accounts);
    cache.recordLastPost('1', { status: 'ok', postedAt: NOW - 200 * DAY });
    clock.sleep(40 * DAY); // checked 40 days ago: stale if active (30-day recheck), fresh if inactive (90)
    expect(countLastPostFetches(cache, accounts)).toBe(1);
    expect(countLastPostFetches(cache, accounts, { inactiveAfterMs: 100 * DAY })).toBe(0);
  });
});

describe('fetchLastPosts', () => {
  test('checks each account, calling X only for stale, fetchable ones, and never gives up on a 429', async () => {
    const accounts = [profile('1'), profile('p', { protected: true }), profile('0', { tweetCount: 0 }), profile('2')];
    const { cache, client, fetch, fetchedIds, lastPost } = setup(accounts);
    const progress: number[] = [];
    const summary = await fetchLastPosts({ client, cache, accounts, onProgress: (p) => progress.push(p.done) });

    expect(fetchedIds()).toEqual(['1', '2']);
    for (const [, , options] of fetch.mock.calls) expect(options).toMatchObject({ maxRateLimitWaits: Infinity });
    expect([lastPost('1'), lastPost('p'), lastPost('0'), lastPost('2')]).toEqual(['ok', null, 'no_posts', 'ok']);
    expect(summary).toMatchObject({ total: 4, done: 4, fetched: 2, recorded: 1, skipped: 1, failed: [], cancelled: false });
    expect(progress).toEqual([1, 2, 3, 4]);
  });

  test('cancelling mid-run keeps the completed results, and a rerun picks up the rest', async () => {
    const accounts = ['1', '2', '3', '4'].map((id) => profile(id));
    const { cache, client, fetch, fetchedIds, lastPost } = setup(accounts);
    const controller = new AbortController();
    fetch.mockImplementation(async () => {
      if (fetch.mock.calls.length === 2) controller.abort();
      return tweets();
    });

    const summary = await fetchLastPosts({ client, cache, accounts, signal: controller.signal });
    expect(summary).toMatchObject({ done: 2, fetched: 2, cancelled: true });
    expect(accounts.map((a) => lastPost(a.id))).toEqual(['ok', 'ok', null, null]);

    fetch.mockClear();
    await fetchLastPosts({ client, cache, accounts: cache.staleAccounts() });
    expect(fetchedIds()).toEqual(['3', '4']);
  });

  test('paces calls through the limiter and reports when it will resume', async () => {
    const accounts = ['1', '2', '3'].map((id) => profile(id));
    const { cache, client, fetch, clock } = setup(accounts);
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: clock.now, sleep: clock.sleep });
    const waits: number[] = [];
    const callTimes: number[] = [];
    fetch.mockImplementation(async () => {
      callTimes.push(clock.now());
      return tweets();
    });

    await fetchLastPosts({ client, cache, accounts, limiter, onRateLimit: (at) => waits.push(at) });
    expect(callTimes).toEqual([NOW, NOW, NOW + 60_000]);
    expect(waits).toEqual([NOW + 60_000]);
  });

  test('cancelling while waiting for the limiter stops at once', async () => {
    const accounts = ['1', '2'].map((id) => profile(id));
    const { cache, client, fetchedIds, clock } = setup(accounts);
    const controller = new AbortController();
    const limiter = createRateLimiter({ limit: 1, windowMs: 60_000, now: clock.now, sleep: async () => controller.abort() });
    const summary = await fetchLastPosts({ client, cache, accounts, limiter, signal: controller.signal });
    expect(fetchedIds()).toEqual(['1']);
    expect(summary).toMatchObject({ done: 1, cancelled: true });
  });

  test('an account X returns an unreadable answer for is listed as failed, and the run goes on', async () => {
    const accounts = ['1', '2'].map((id) => profile(id));
    const { cache, client, fetch, lastPost } = setup(accounts);
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    const summary = await fetchLastPosts({ client, cache, accounts });
    expect(summary.failed).toEqual([{ handle: 'user1', message: expect.stringContaining('503') }]);
    expect(summary).toMatchObject({ done: 2, fetched: 1 });
    expect([lastPost('1'), lastPost('2')]).toEqual([null, 'ok']);
  });
});
