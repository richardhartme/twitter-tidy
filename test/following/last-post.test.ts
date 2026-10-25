import { describe, expect, test, vi } from 'vitest';
import type { XClient } from '../../src/auth/index.js';
import { openCache, type AccountProfile } from '../../src/cache/index.js';
import { checkLastPost, FetchError } from '../../src/following/index.js';

const DAY = 86_400_000;
const NOW = 2_000 * DAY;
const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

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

/** A fake client answering from `responses` in order, and a cache following `accounts`, at a settable clock. */
function setup(accounts: AccountProfile[], responses: Response[] = []) {
  let t = NOW;
  const clock = { set: (ms: number) => (t = ms) };
  const cache = openCache({ path: ':memory:', now: () => t });
  cache.applyFollowing(accounts);
  const fetch = vi.fn(async (_path: string, _init?: RequestInit, _options?: unknown) => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected request');
    return next;
  });
  const client = { fetch, tokens: {} } as unknown as XClient;
  const lastPost = (id: string) => cache.listFollowing().find((a) => a.id === id)?.lastPost ?? null;
  return { cache, client, fetch, clock, lastPost };
}

const tweets = (...createdAt: string[]) =>
  json({ data: createdAt.map((c, i) => ({ id: String(i), text: 't', created_at: c })), meta: { result_count: createdAt.length } });

describe('checkLastPost', () => {
  test('fetches the five newest posts with their dates and records the newest', async () => {
    const account = profile('7');
    const { cache, client, fetch, lastPost } = setup([account], [
      tweets('2026-03-01T10:00:00.000Z', '2026-03-04T09:00:00.000Z', '2026-02-01T00:00:00.000Z'),
    ]);
    const outcome = await checkLastPost({ client, cache, account });

    const postedAt = Date.parse('2026-03-04T09:00:00.000Z');
    expect(outcome).toEqual({ action: 'fetched', result: { status: 'ok', postedAt } });
    expect(lastPost('7')).toEqual({ status: 'ok', postedAt, checkedAt: NOW });
    expect(fetch).toHaveBeenCalledTimes(1);
    const url = new URL(fetch.mock.calls[0]![0], 'https://api.x.com');
    expect(url.pathname).toBe('/2/users/7/tweets');
    expect(url.searchParams.get('max_results')).toBe('5');
    expect(url.searchParams.get('tweet.fields')).toBe('created_at');
  });

  test('protected and suspended accounts are skipped without a call', async () => {
    const prot = profile('p', { protected: true });
    const susp = profile('s', { suspended: true });
    const { cache, client, fetch, lastPost } = setup([prot, susp]);
    expect(await checkLastPost({ client, cache, account: prot })).toEqual({ action: 'skipped', reason: 'protected' });
    expect(await checkLastPost({ client, cache, account: susp })).toEqual({ action: 'skipped', reason: 'suspended' });
    expect(fetch).not.toHaveBeenCalled();
    expect([lastPost('p'), lastPost('s')]).toEqual([null, null]);
  });

  test('an account with no posts is recorded as "no posts" without a call', async () => {
    const account = profile('0', { tweetCount: 0 });
    const { cache, client, fetch, lastPost } = setup([account]);
    expect(await checkLastPost({ client, cache, account })).toEqual({ action: 'recorded', result: { status: 'no_posts' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(lastPost('0')).toEqual({ status: 'no_posts', postedAt: null, checkedAt: NOW });
  });

  test('fresh entries are skipped without a call; stale ones are fetched again', async () => {
    const active = profile('a');
    const inactive = profile('i');
    const none = profile('n', { tweetCount: 0 });
    const { cache, client, fetch, clock } = setup([active, inactive, none], [
      tweets('2026-01-01T00:00:00.000Z'),
      tweets('2020-01-01T00:00:00.000Z'),
    ]);
    // Checked at NOW: posted 10 days ago, 400 days ago, never.
    cache.recordLastPost('a', { status: 'ok', postedAt: NOW - 10 * DAY });
    cache.recordLastPost('i', { status: 'ok', postedAt: NOW - 400 * DAY });
    cache.recordLastPost('n', { status: 'no_posts' });
    const check = (account: AccountProfile) => checkLastPost({ client, cache, account });
    const fresh = { action: 'skipped', reason: 'fresh' };

    clock.set(NOW + 29 * DAY);
    expect([await check(active), await check(inactive), await check(none)]).toEqual([fresh, fresh, fresh]);
    clock.set(NOW + 31 * DAY);
    expect((await check(active)).action).toBe('fetched');
    expect([await check(inactive), await check(none)]).toEqual([fresh, fresh]);
    clock.set(NOW + 91 * DAY);
    expect((await check(inactive)).action).toBe('fetched');
    expect((await check(none)).action).toBe('recorded');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('the inactivity threshold decides which recheck limit applies', async () => {
    const account = profile('1');
    const { cache, client, fetch, clock } = setup([account]);
    cache.recordLastPost('1', { status: 'ok', postedAt: NOW - 100 * DAY });
    clock.set(NOW + 31 * DAY);
    expect(await checkLastPost({ client, cache, account, inactiveAfterMs: 90 * DAY })).toEqual({
      action: 'skipped',
      reason: 'fresh',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('an empty timeline records "no posts"', async () => {
    const account = profile('1', { tweetCount: null });
    const { cache, client, lastPost } = setup([account], [json({ meta: { result_count: 0 } })]);
    expect(await checkLastPost({ client, cache, account })).toEqual({ action: 'fetched', result: { status: 'no_posts' } });
    expect(lastPost('1')).toEqual({ status: 'no_posts', postedAt: null, checkedAt: NOW });
  });

  test('records "protected" or "suspended" when X reports it for an account the profile thought readable', async () => {
    const prot = profile('p');
    const susp = profile('s');
    const { cache, client, lastPost } = setup([prot, susp], [
      json({
        errors: [
          {
            title: 'Authorization Error',
            detail: 'Sorry, you are not authorized to see the Tweets of this user.',
            type: 'https://api.twitter.com/2/problems/not-authorized-for-resource',
          },
        ],
      }),
      json(
        {
          errors: [
            {
              title: 'Forbidden',
              detail: 'User has been suspended: [s].',
              type: 'https://api.twitter.com/2/problems/resource-not-found',
            },
          ],
        },
        { status: 403 },
      ),
    ]);
    expect(await checkLastPost({ client, cache, account: prot })).toEqual({ action: 'fetched', result: { status: 'protected' } });
    expect(await checkLastPost({ client, cache, account: susp })).toEqual({ action: 'fetched', result: { status: 'suspended' } });
    expect([lastPost('p')?.status, lastPost('s')?.status]).toEqual(['protected', 'suspended']);
  });

  test('any other error status throws a FetchError and records nothing', async () => {
    const account = profile('1');
    const { cache, client, lastPost } = setup([account], [json({ title: 'Service Unavailable' }, { status: 503 })]);
    const error = await checkLastPost({ client, cache, account }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FetchError);
    expect(error).toMatchObject({ status: 503, message: expect.stringContaining('@user1') });
    expect(lastPost('1')).toBeNull();
  });

  test('passes rate-limit handling through to the client', async () => {
    const account = profile('1');
    const { cache, client, fetch } = setup([account], [tweets('2026-01-01T00:00:00.000Z')]);
    const onRateLimit = vi.fn();
    await checkLastPost({ client, cache, account, onRateLimit, maxRateLimitWaits: Infinity });
    expect(fetch.mock.calls[0]![2]).toEqual({ onRateLimit, maxRateLimitWaits: Infinity });
  });
});
