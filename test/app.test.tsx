import { render } from 'ink-testing-library';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../src/app.js';
import type { XClient } from '../src/auth/index.js';
import { openCache, type AccountProfile } from '../src/cache/index.js';
import { createRateLimiter, type RateLimiter } from '../src/following/index.js';

const json = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), init);
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

function setup(seed: string[] = [], { height }: { height?: number } = {}) {
  const cache = openCache({ path: ':memory:' });
  if (seed.length) cache.applyFollowing(seed.map(profile));
  const fetch = vi.fn(async () => json({ data: ['1', '2', '3'].map(xUser), meta: { result_count: 3 } }));
  const client = { fetch, tokens: {} } as unknown as XClient;
  const app = render(<App client={client} cache={cache} userId="42" height={height} />);
  return { ...app, fetch, cache };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const press = async (stdin: { write: (s: string) => void }, key: string) => {
  stdin.write(key);
  await tick();
};
const REFRESH = 'r';

describe('main screen', () => {
  test('opens on the Following table, read from the cache without API calls', async () => {
    const { lastFrame, fetch } = setup(['1', '2']);
    await tick();
    expect(lastFrame()).toContain('@user1');
    expect(lastFrame()).toContain('@user2');
    expect(lastFrame()).toContain('2 accounts');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('shows only as many rows as fit the given height', async () => {
    const { lastFrame } = setup(['1', '2', '3', '4'], { height: 2 });
    await tick();
    expect(lastFrame()).toContain('@user2');
    expect(lastFrame()).not.toContain('@user3');
  });
});

describe('Refresh Following', () => {
  test('shows the rate before the first pull, and declining makes no API calls', async () => {
    const { stdin, lastFrame, fetch } = setup();
    await tick();
    await press(stdin, REFRESH);
    // A Following read plus its accounts' most recent posts.
    expect(lastFrame()).toContain('$0.015 per account ($15.00 per 1,000)');
    expect(fetch).not.toHaveBeenCalled();

    await press(stdin, 'n');
    expect(lastFrame()).toContain('No accounts cached yet');
    expect(lastFrame()).not.toContain('per account');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('estimates from the last pull, and confirming pulls and shows the summary', async () => {
    const { stdin, lastFrame, fetch, cache } = setup(['1', '4']);
    await tick();
    await press(stdin, REFRESH);
    expect(lastFrame()).toContain('About $0.03 for ~2 accounts (based on your last pull)');
    expect(fetch).not.toHaveBeenCalled();

    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('3 accounts followed'));
    expect(lastFrame()).toContain('2 new');
    expect(lastFrame()).toContain('1 removed');
    expect(lastFrame()).toContain('0 restored');
    expect(lastFrame()).toContain('0 last tweets dated');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.listFollowing().map((a) => a.id)).toEqual(['1', '2', '3']);

    await press(stdin, 'x');
    expect(lastFrame()).toContain('3 accounts');
    expect(lastFrame()).toContain('@user3');
    expect(lastFrame()).not.toContain('@user4');
  });

  test('a failed pull shows the error and changes nothing', async () => {
    const { stdin, lastFrame, fetch, cache } = setup(['1']);
    fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
    await tick();
    await press(stdin, REFRESH);
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('503'));
    expect(cache.listFollowing().map((a) => a.id)).toEqual(['1']);
  });
});

describe('refresh flags', () => {
  /** An app whose next API calls return each list of ids in turn. */
  function setupPulls(seed: string[], pulls: string[][]) {
    const app = setup(seed);
    for (const ids of pulls) {
      app.fetch.mockResolvedValueOnce(json({ data: ids.map(xUser), meta: { result_count: ids.length } }));
    }
    const refresh = async (summary: RegExp) => {
      await press(app.stdin, REFRESH);
      await press(app.stdin, 'y');
      await vi.waitFor(() => expect(app.lastFrame()).toMatch(summary));
      await press(app.stdin, ' ');
    };
    const line = (handle: string) => (app.lastFrame() ?? '').split('\n').find((l) => l.includes(`@${handle} `)) ?? '';
    return { ...app, refresh, line };
  }

  test('new and removed markers match the diff between two refreshes, and clear on the next', async () => {
    const { refresh, line, lastFrame, stdin } = setupPulls(['1', '2', '3'], [['2', '3', '4', '5'], ['2', '3', '4', '5']]);
    await tick();

    await refresh(/2 new · 1 removed/);
    expect(line('user4')).toMatch(/@user4 +new/);
    expect(line('user5')).toMatch(/@user5 +new/);
    expect(line('user2')).not.toContain('new');
    expect(lastFrame()).not.toContain('@user1 ');
    expect(lastFrame()).toContain('2 new');

    await press(stdin, 'x');
    expect(lastFrame()).toContain('1 removed accounts');
    expect(line('user1')).toMatch(/@user1 +removed +.*\d{4}-\d{2}-\d{2}/);
    expect(lastFrame()).not.toContain('@user2 ');
    await press(stdin, 'x');

    await refresh(/0 new · 0 removed/);
    expect(line('user4')).not.toContain('new');
    expect(lastFrame()).not.toContain('2 new');

    // Removed accounts stay listed after later refreshes, without the recent flag.
    await press(stdin, 'x');
    expect(line('user1')).toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(line('user1')).not.toContain('removed');
  });

  test('F refreshes followers, then the table shows who follows back', async () => {
    const { stdin, lastFrame, fetch, line } = setupPulls(['1', '2'], [['1']]);
    await tick();
    expect(line('user1')).toContain('unknown');

    await press(stdin, 'F');
    expect(lastFrame()).toContain('Refresh followers');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Followers refreshed'));
    expect(String(fetch.mock.calls[0]?.at(0))).toContain('/followers');

    await press(stdin, ' ');
    expect(line('user1')).toMatch(/@user1 +yes/);
    expect(line('user2')).toMatch(/@user2 +no/);
  });
});

describe('Fetch last tweet (l)', () => {
  /** An app over a cache seeded with `profiles`, whose client answers every call with `respond`. */
  function setupWith(profiles: AccountProfile[], respond: () => Promise<Response>) {
    const cache = openCache({ path: ':memory:' });
    cache.applyFollowing(profiles);
    const fetch = vi.fn(respond);
    const client = { fetch, tokens: {} } as unknown as XClient;
    const app = render(<App client={client} cache={cache} userId="42" height={5} />);
    const line = (handle: string) => (app.lastFrame() ?? '').split('\n').find((l) => l.includes(`@${handle} `)) ?? '';
    return { ...app, fetch, cache, line };
  }

  test('fetches the highlighted row, then updates the row and the status bar', async () => {
    const { stdin, lastFrame, fetch, line } = setupWith([profile('1'), profile('2')], async () =>
      json({ data: [{ id: 't', text: 'hi', created_at: '2026-04-05T06:07:08.000Z' }], meta: { result_count: 1 } }),
    );
    await tick();
    await press(stdin, '\u001B[B');
    await press(stdin, 'l');
    await vi.waitFor(() => expect(lastFrame()).toContain('@user2 last posted 2026-04-05'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toMatch(/^\/2\/users\/2\/tweets\?/);
    expect(line('user2')).toContain('2026-04-05');
    expect(line('user1')).toContain('unknown');
  });

  test('a fresh entry makes no call and says so', async () => {
    const { stdin, lastFrame, fetch, cache } = setupWith([profile('1')], async () => json({}));
    cache.recordLastPost('1', { status: 'ok', postedAt: Date.now() - 86_400_000 });
    await tick();
    await press(stdin, 'l');
    await vi.waitFor(() => expect(lastFrame()).toContain('@user1 is up to date'));
    expect(fetch).not.toHaveBeenCalled();
  });

  test('a protected account makes no call and is labelled', async () => {
    const { stdin, lastFrame, fetch, line } = setupWith([{ ...profile('1'), protected: true }], async () => json({}));
    await tick();
    await press(stdin, 'l');
    await vi.waitFor(() => expect(lastFrame()).toContain('@user1 is protected; skipped'));
    expect(fetch).not.toHaveBeenCalled();
    expect(line('user1')).toContain('protected');
  });

  test('a failed fetch shows the error and records nothing', async () => {
    const { stdin, lastFrame, cache } = setupWith([profile('1')], async () => new Response('{}', { status: 500 }));
    await tick();
    await press(stdin, 'l');
    await vi.waitFor(() => expect(lastFrame()).toContain("Couldn't fetch @user1's last tweet"));
    expect(cache.listFollowing()[0]?.lastPost).toBeNull();
  });
});

describe('Inactivity threshold', () => {
  const DAY = 86_400_000;
  /** A cache whose one account posted 60 days ago, last checked 40 days ago. */
  function setupChecked(inactiveAfterMs?: number) {
    let clock = Date.now() - 40 * DAY;
    const cache = openCache({ path: ':memory:', now: () => clock });
    cache.applyFollowing([profile('1')]);
    cache.recordLastPost('1', { status: 'ok', postedAt: Date.now() - 60 * DAY });
    clock = Date.now();
    const fetch = vi.fn(async () => json({ data: [{ id: 't', created_at: new Date().toISOString() }] }));
    const client = { fetch, tokens: {} } as unknown as XClient;
    const app = render(<App client={client} cache={cache} userId="42" height={5} inactiveAfterMs={inactiveAfterMs} />);
    const line = () => (app.lastFrame() ?? '').split('\n').find((l) => l.includes('@user1 ')) ?? '';
    return { ...app, fetch, line };
  }

  test('the default 12 months: active, so a 40-day-old check is stale and l fetches', async () => {
    const { stdin, line, fetch, lastFrame } = setupChecked();
    await tick();
    expect(line()).not.toContain('inactive');
    await press(stdin, 'l');
    await vi.waitFor(() => expect(lastFrame()).toContain('@user1 last posted'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('a configured threshold flags the row and applies the inactive re-check interval', async () => {
    const { stdin, line, fetch, lastFrame } = setupChecked(30 * DAY);
    await tick();
    expect(line()).toContain('inactive');
    await press(stdin, 'l');
    await vi.waitFor(() => expect(lastFrame()).toContain('@user1 is up to date'));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('One rate limit across the app', () => {
  const WINDOW = 60_000;

  /** The most calls made in any window of `windowMs`, given sorted call times. */
  function busiestWindow(times: number[], windowMs: number) {
    let most = 0;
    let start = 0;
    for (let end = 0; end < times.length; end++) {
      while (times[end]! - times[start]! >= windowMs) start++;
      most = Math.max(most, end - start + 1);
    }
    return most;
  }

  test('single fetches and successive bulk runs share one limiter', async () => {
    let t = 5_000_000;
    const limiter = createRateLimiter({
      limit: 2,
      windowMs: WINDOW,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    const cache = openCache({ path: ':memory:' });
    cache.applyFollowing(['1', '2', '3', '4'].map(profile));
    const callTimes: number[] = [];
    const fetch = vi.fn(async () => {
      callTimes.push(t);
      return json({ data: [{ id: 't', created_at: '2026-04-05T06:07:08.000Z' }] });
    });
    const client = { fetch, tokens: {} } as unknown as XClient;
    const { stdin, lastFrame } = render(
      <App client={client} cache={cache} userId="42" height={10} limiter={limiter} />,
    );
    const DOWN = '\u001B[B';
    await tick();

    await press(stdin, 'l'); // user1
    await vi.waitFor(() => expect(lastFrame()).toContain('@user1 last posted'));

    for (const row of [1, 2]) {
      // Mark the next row and fetch it as a batch.
      for (let i = 0; i < row; i++) await press(stdin, DOWN);
      await press(stdin, ' ');
      await press(stdin, 'b');
      await press(stdin, 'y');
      await vi.waitFor(() => expect(lastFrame()).toContain('Checked 1 account'));
      await press(stdin, ' ');
    }

    await press(stdin, DOWN);
    await press(stdin, DOWN);
    await press(stdin, DOWN);
    await press(stdin, 'l'); // user4
    await vi.waitFor(() => expect(lastFrame()).toContain('@user4 last posted'));

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(busiestWindow(callTimes, WINDOW)).toBe(2);
  });
});

describe('Open profile (o)', () => {
  test("opens the highlighted account's x.com profile without any API call", async () => {
    const cache = openCache({ path: ':memory:' });
    cache.applyFollowing([profile('1'), profile('2')]);
    const fetch = vi.fn();
    const client = { fetch, tokens: {} } as unknown as XClient;
    const openUrl = vi.fn();
    const { stdin } = render(<App client={client} cache={cache} userId="42" height={5} openUrl={openUrl} />);
    await press(stdin, '\u001B[B');
    await press(stdin, 'o');
    expect(openUrl).toHaveBeenCalledWith(`https://x.com/${profile('2').handle}`);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Unfollow one account (u)', () => {
  const DOWN = '\u001B[B';
  const ENTER = '\r';

  function setupUnfollow(
    respond: () => Response = () => json({ data: { following: false } }),
    { protectedIds = [] as string[], unfollowLimiter = undefined as RateLimiter | undefined } = {},
  ) {
    const cache = openCache({ path: ':memory:' });
    cache.applyFollowing(['1', '2', '3'].map((id) => ({ ...profile(id), protected: protectedIds.includes(id) })));
    const fetch = vi.fn(async (_path: string, _init?: RequestInit) => respond());
    const client = { fetch, tokens: {} } as unknown as XClient;
    const app = render(<App client={client} cache={cache} userId="42" height={5} unfollowLimiter={unfollowLimiter} />);
    const deletes = () => fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([path]) => path);
    return { ...app, fetch, cache, deletes };
  }

  test('asks first, with the cost; anything but y cancels without a call', async () => {
    const { stdin, lastFrame, deletes } = setupUnfollow();
    await tick();
    await press(stdin, DOWN);
    await press(stdin, 'u');
    expect(lastFrame()).toContain('Unfollow @user2?');
    expect(lastFrame()).toContain('About $0.01');
    // No is the default: Enter cancels.
    await press(stdin, ENTER);
    expect(lastFrame()).not.toContain('Unfollow @user2?');
    expect(lastFrame()).toContain('@user2');
    await press(stdin, 'u');
    await press(stdin, 'n');
    expect(lastFrame()).toContain('@user2');
    expect(deletes()).toEqual([]);
  });

  test('y unfollows, the account leaves the table at once, and shows as unfollowed in the removed view', async () => {
    const { stdin, lastFrame, deletes } = setupUnfollow();
    await tick();
    await press(stdin, DOWN);
    await press(stdin, 'u');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Unfollowed @user2'));
    expect(deletes()).toEqual(['/2/users/42/following/2']);
    expect(lastFrame()).not.toContain('❯ @user2');
    // The highlight stays at the same position, now on the next account.
    expect(lastFrame()).toContain('❯ @user3');
    await press(stdin, 'x');
    expect(lastFrame()).toMatch(/@user2 .*unfollowed/);
  });

  test('warns that re-following a protected account needs their approval', async () => {
    const { stdin, lastFrame } = setupUnfollow(undefined, { protectedIds: ['1'] });
    await tick();
    await press(stdin, 'u');
    expect(lastFrame()).toContain('protected');
    expect(lastFrame()).toContain('approval');
  });

  test('u in the detail pane asks, unfollows and returns to the table', async () => {
    const { stdin, lastFrame, deletes } = setupUnfollow();
    await tick();
    await press(stdin, ENTER);
    await press(stdin, 'u');
    expect(lastFrame()).toContain('Unfollow @user1?');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Unfollowed @user1'));
    expect(deletes()).toEqual(['/2/users/42/following/1']);
    expect(lastFrame()).toContain('❯ @user2');
  });

  test('refuses without a call when the unfollow limit is used up, saying when to try again', async () => {
    const unfollowLimiter = createRateLimiter({ limit: 1, windowMs: 15 * 60_000, now: () => Date.parse('2026-10-26T14:17:00') });
    const { stdin, lastFrame, deletes } = setupUnfollow(undefined, { unfollowLimiter });
    await tick();
    await press(stdin, 'u');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Unfollowed @user1'));
    await press(stdin, 'u');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toMatch(/try again at \S*:32/));
    expect(deletes()).toHaveLength(1);
    expect(lastFrame()).toContain('@user2');
  });

  test("X's own rate limit or refusal is reported, and the account stays", async () => {
    const limited = setupUnfollow(() => new Response(null, { status: 429, headers: { 'x-rate-limit-reset': String(Date.parse('2026-10-26T09:05:00') / 1000) } }));
    await tick();
    await press(limited.stdin, 'u');
    await press(limited.stdin, 'y');
    await vi.waitFor(() => expect(limited.lastFrame()).toMatch(/try again at \S*:05/));
    expect(limited.deletes()).toHaveLength(1);
    expect(limited.lastFrame()).toContain('❯ @user1');

    const refused = setupUnfollow(() => json({ detail: 'Not permitted.' }, { status: 403 }));
    await tick();
    await press(refused.stdin, 'u');
    await press(refused.stdin, 'y');
    await vi.waitFor(() => expect(refused.lastFrame()).toMatch(/Not permitted/));
    expect(refused.lastFrame()).toContain('❯ @user1');
  });
});

describe('Unfollow marked accounts (U)', () => {
  const DOWN = '\u001B[B';
  const ENTER = '\r';

  function setupBatch(respond: (path: string) => Response = () => json({ data: { following: false } })) {
    const cache = openCache({ path: ':memory:' });
    cache.applyFollowing(['1', '2', '3'].map(profile));
    const fetch = vi.fn(async (path: string, _init?: RequestInit) => respond(path));
    const client = { fetch, tokens: {} } as unknown as XClient;
    const app = render(<App client={client} cache={cache} userId="42" height={5} />);
    const deletes = () => fetch.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([path]) => path);
    /** Marks user1 and user3. */
    const markOneAndThree = async () => {
      await tick();
      await press(app.stdin, ' ');
      await press(app.stdin, DOWN);
      await press(app.stdin, ' ');
    };
    return { ...app, deletes, markOneAndThree };
  }

  test('with nothing marked, says how to mark', async () => {
    const { stdin, lastFrame, deletes } = setupBatch();
    await tick();
    await press(stdin, 'U');
    expect(lastFrame()).toContain('Mark rows with space, then press U');
    expect(deletes()).toEqual([]);
  });

  test('asks first, listing the handles and cost; cancelling keeps the marks', async () => {
    const { stdin, lastFrame, deletes, markOneAndThree } = setupBatch();
    await markOneAndThree();
    await press(stdin, 'U');
    expect(lastFrame()).toContain('Unfollow 2 marked accounts?');
    expect(lastFrame()).toContain('@user1, @user3');
    expect(lastFrame()).toContain('About $0.02');
    await press(stdin, ENTER);
    expect(lastFrame()).toContain('2 marked');
    expect(deletes()).toEqual([]);
  });

  test('y unfollows every marked account and clears their marks', async () => {
    const { stdin, lastFrame, deletes, markOneAndThree } = setupBatch();
    await markOneAndThree();
    await press(stdin, 'U');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Unfollowed 2 accounts'));
    expect(deletes()).toEqual(['/2/users/42/following/1', '/2/users/42/following/3']);
    await press(stdin, ENTER);
    expect(lastFrame()).toContain('1 accounts');
    expect(lastFrame()).not.toMatch(/\d marked/);
  });

  test('includes marked accounts the current search hides, and says so', async () => {
    const { stdin, lastFrame, markOneAndThree } = setupBatch();
    await markOneAndThree();
    for (const key of ['/', 'u', 's', 'e', 'r', '2', ENTER]) await press(stdin, key);
    await press(stdin, 'U');
    expect(lastFrame()).toContain('Unfollow 2 marked accounts?');
    expect(lastFrame()).toContain('2 of them are not shown by the current view');
  });

  test('a refusal stops the run; accounts not unfollowed stay marked, and U again carries on', async () => {
    let refuse = true;
    const { stdin, lastFrame, deletes, markOneAndThree } = setupBatch((path) =>
      refuse && path.endsWith('/3') ? json({ detail: 'Not permitted.' }, { status: 403 }) : json({ data: { following: false } }),
    );
    await markOneAndThree();
    await press(stdin, 'U');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toMatch(/Not permitted/));
    expect(lastFrame()).toContain('1 of 2');
    await press(stdin, ENTER);
    expect(lastFrame()).toContain('1 marked');
    expect(lastFrame()).not.toContain('@user1');

    refuse = false;
    await press(stdin, 'U');
    expect(lastFrame()).toContain('Unfollow @user3?');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Unfollowed 1 account'));
    expect(deletes()).toEqual(['/2/users/42/following/1', '/2/users/42/following/3', '/2/users/42/following/3']);
  });
});
