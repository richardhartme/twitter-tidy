import { describe, expect, test, vi } from 'vitest';
import type { XClient } from '../../src/auth/index.js';
import { openCache, type AccountProfile } from '../../src/cache/index.js';
import { unfollowAccount, UnfollowError } from '../../src/unfollow/index.js';

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
    expect(err).toMatchObject({ kind: 'forbidden' });
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
