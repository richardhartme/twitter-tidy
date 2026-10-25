import { render } from 'ink-testing-library';
import { describe, expect, test, vi } from 'vitest';
import type { XClient } from '../../src/auth/index.js';
import { openCache, type AccountProfile } from '../../src/cache/index.js';
import { FollowersRefresh } from '../../src/components/followers-refresh.js';

const json = (body: unknown) => new Response(JSON.stringify(body));
const xUser = (id: string) => ({ id, username: `user${id}`, name: `User ${id}` });

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

/** Renders the screen over a cache following 1, 2 and 3; the fake API reports followers 1, 3 and 9. */
function setup({ followers }: { followers?: string[] } = {}) {
  const cache = openCache({ path: ':memory:' });
  cache.applyFollowing(['1', '2', '3'].map(profile));
  if (followers) cache.replaceFollowers(followers);
  const fetch = vi.fn(async () => json({ data: ['1', '3', '9'].map(xUser), meta: { result_count: 3 } }));
  const client = { fetch, tokens: {} } as unknown as XClient;
  const onDone = vi.fn();
  const screen = render(<FollowersRefresh client={client} cache={cache} userId="42" onDone={onDone} />);
  return { ...screen, fetch, cache, onDone };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const press = async (stdin: { write: (s: string) => void }, key: string) => {
  stdin.write(key);
  await tick();
};

describe('FollowersRefresh', () => {
  test('shows the rate before the first pull, and declining makes no API calls', async () => {
    const { stdin, lastFrame, fetch, onDone, cache } = setup();
    await tick();
    expect(lastFrame()).toContain('Refresh followers');
    expect(lastFrame()).toContain('$0.01 per account ($10.00 per 1,000)');

    await press(stdin, 'n');
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(cache.listFollowing().map((a) => a.followsBack)).toEqual([null, null, null]);
  });

  test('estimates from the last pull, and confirming pulls, updates follows-back and shows the summary', async () => {
    const { stdin, lastFrame, fetch, cache, onDone } = setup({ followers: ['1', '5'] });
    await tick();
    expect(lastFrame()).toContain('About $0.02 for ~2 accounts (based on your last pull)');
    expect(fetch).not.toHaveBeenCalled();

    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('3 followers'));
    expect(lastFrame()).toContain('2 of the accounts you follow follow you back');
    expect(lastFrame()).toContain("1 doesn't");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.listFollowing().map((a) => [a.id, a.followsBack])).toEqual([
      ['1', true],
      ['2', false],
      ['3', true],
    ]);

    expect(onDone).not.toHaveBeenCalled();
    await press(stdin, 'x');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('a failed pull shows the error and changes nothing', async () => {
    const { stdin, lastFrame, fetch, cache, onDone } = setup({ followers: ['2'] });
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await tick();
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('503'));
    expect(lastFrame()).toContain('nothing was changed');
    expect(cache.listFollowing().map((a) => a.followsBack)).toEqual([false, true, false]);

    await press(stdin, 'x');
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
