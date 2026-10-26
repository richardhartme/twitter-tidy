import { describe, expect, test, vi } from 'vitest';
import type { XClient } from '../../src/auth/index.js';
import { openCache, type AccountProfile } from '../../src/cache/index.js';
import { createRateLimiter } from '../../src/following/index.js';
import { unfollowAccount, unfollowAccounts, UnfollowError } from '../../src/unfollow/index.js';

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);

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

function setup(...responses: (Response | Error)[]) {
  const cache = openCache({ path: ':memory:' });
  cache.applyFollowing([profile('1'), profile('2')]);
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => {
    const next = responses.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  const client = { fetch, tokens: {} } as unknown as XClient;
  const run = () => unfollowAccount({ client, cache, userId: '42', account: profile('2') });
  const following = () => cache.listFollowing().map((a) => a.id);
  return { cache, fetch, run, following };
}

describe('unfollowAccount', () => {
  test('sends a DELETE for the logged-in user and records the unfollow', async () => {
    const { fetch, run, following, cache } = setup(json({ data: { following: false } }));
    await run();
    expect(fetch).toHaveBeenCalledWith('/2/users/42/following/2', { method: 'DELETE' }, expect.anything());
    expect(following()).toEqual(['1']);
    expect(cache.listRemoved().map((a) => [a.id, a.removedBy])).toEqual([['2', 'app']]);
  });

  test('an account X no longer knows (404) counts as unfollowed', async () => {
    const { run, following } = setup(json({ errors: [{ title: 'Not Found Error' }] }, { status: 404 }));
    await run();
    expect(following()).toEqual(['1']);
  });

  test('a 403 is refused, with X\'s reason and what to check, and nothing is recorded', async () => {
    const { run, following } = setup(json({ detail: 'You are not permitted to perform this action.' }, { status: 403 }));
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnfollowError);
    expect(err).toMatchObject({ kind: 'failed' });
    expect((err as Error).message).toMatch(/not permitted/);
    expect((err as Error).message).toMatch(/Read and write/);
    expect(following()).toEqual(['1', '2']);
  });

  test('a 429 is rate-limited, carrying when the limit resets', async () => {
    const { run, following } = setup(new Response(null, { status: 429, headers: { 'x-rate-limit-reset': '1800' } }));
    await expect(run()).rejects.toMatchObject({ kind: 'rate-limited', resetAt: 1_800_000 });
    expect(following()).toEqual(['1', '2']);
  });

  test('any other status, or a network error, fails without recording anything', async () => {
    const server = setup(new Response('oops', { status: 500 }));
    await expect(server.run()).rejects.toMatchObject({ kind: 'failed', message: expect.stringMatching(/500/) });
    expect(server.following()).toEqual(['1', '2']);

    const offline = setup(new TypeError('fetch failed'));
    await expect(offline.run()).rejects.toMatchObject({ kind: 'failed', message: expect.stringMatching(/fetch failed/) });
  });
});

describe('unfollowAccounts', () => {
  const ids = ['1', '2', '3', '4', '5'];

  function setupBatch(respond: (path: string) => Response = () => json({ data: { following: false } })) {
    let t = 1_000_000;
    const limiter = createRateLimiter({ limit: 2, windowMs: 60_000, now: () => t, sleep: async (ms) => void (t += ms) });
    const cache = openCache({ path: ':memory:', now: () => t });
    cache.applyFollowing(ids.map(profile));
    const callTimes: number[] = [];
    const fetch = vi.fn(async (path: string) => {
      callTimes.push(t);
      return respond(path);
    });
    const client = { fetch, tokens: {} } as unknown as XClient;
    const controller = new AbortController();
    const run = (onProgress?: (p: { done: number; total: number }) => void, onRateLimit?: (resumeAt: number) => void) =>
      unfollowAccounts({ client, cache, userId: '42', accounts: ids.map(profile), limiter, signal: controller.signal, onProgress, onRateLimit });
    const following = () => cache.listFollowing().map((a) => a.id);
    return { run, following, callTimes, controller, cache };
  }

  test('unfollows each account in turn, never more than the limit in any window', async () => {
    const { run, following, callTimes } = setupBatch();
    const summary = await run();
    expect(summary).toMatchObject({ done: 5, total: 5, cancelled: false, error: null });
    expect(following()).toEqual([]);
    // Two per minute: calls 3 and 5 each wait for a window to pass.
    expect(callTimes.map((c) => c - callTimes[0]!)).toEqual([0, 0, 60_000, 60_000, 120_000]);
  });

  test('X refusing one (403) stops the run there; the rest stay followed', async () => {
    const { run, following } = setupBatch((path) =>
      path.endsWith('/3') ? json({ detail: 'Not permitted.' }, { status: 403 }) : json({ data: { following: false } }),
    );
    const summary = await run();
    expect(summary).toMatchObject({ done: 2, total: 5, cancelled: false, error: { kind: 'failed', message: expect.stringMatching(/Read and write/) } });
    expect(following()).toEqual(['3', '4', '5']);
  });

  test('any other failure stops the run too', async () => {
    const { run, following } = setupBatch((path) => (path.endsWith('/2') ? new Response(null, { status: 500 }) : json({})));
    expect(await run()).toMatchObject({ done: 1, error: { kind: 'failed' } });
    expect(following()).toEqual(['2', '3', '4', '5']);
  });

  test('stopping keeps what was done, and leaves the rest followed', async () => {
    const { run, following, controller } = setupBatch();
    const summary = await run(({ done }) => {
      if (done === 2) controller.abort();
    });
    expect(summary).toMatchObject({ done: 2, total: 5, cancelled: true, error: null });
    expect(following()).toEqual(['3', '4', '5']);
  });

  test('stopping while waiting for the limit counts as stopped, not failed', async () => {
    const { run, following, controller } = setupBatch();
    const summary = await run(undefined, () => controller.abort());
    expect(summary).toMatchObject({ done: 2, cancelled: true, error: null });
    expect(following()).toEqual(['3', '4', '5']);
  });
});
