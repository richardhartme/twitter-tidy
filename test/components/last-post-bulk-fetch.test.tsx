import { render } from 'ink-testing-library';
import { describe, expect, test, vi } from 'vitest';
import { App } from '../../src/app.js';
import type { XClient } from '../../src/auth/index.js';
import { openCache, type AccountProfile } from '../../src/cache/index.js';

const DAY = 86_400_000;

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
  followersCount: null,
  followingCount: null,
  tweetCount: 30,
  ...extra,
});

const tweets = () =>
  new Response(JSON.stringify({ data: [{ id: 't', text: 'hi', created_at: '2026-04-05T06:07:08.000Z' }] }));

/** An app over a cache following `profiles`, whose client answers every timeline read. */
function setup(profiles: AccountProfile[]) {
  const cache = openCache({ path: ':memory:' });
  cache.applyFollowing(profiles);
  const fetch = vi.fn(async (_path: string, _init?: RequestInit, _options?: unknown) => tweets());
  const client = { fetch, tokens: {} } as unknown as XClient;
  const app = render(<App client={client} cache={cache} userId="42" height={10} />);
  const fetchedIds = () => fetch.mock.calls.map(([path]) => /\/2\/users\/([^/]+)\/tweets/.exec(path)![1]);
  const line = (handle: string) => (app.lastFrame() ?? '').split('\n').find((l) => l.includes(`@${handle} `)) ?? '';
  return { ...app, fetch, cache, fetchedIds, line };
}

const tick = () => new Promise((r) => setTimeout(r, 20));
const press = async (stdin: { write: (s: string) => void }, key: string) => {
  stdin.write(key);
  await tick();
};
const DOWN = '\u001B[B';
const ESC = '\u001B';

describe('Fetch all stale (a)', () => {
  test('estimates only stale, fetchable accounts, and declining makes no calls', async () => {
    const { stdin, lastFrame, fetch, cache } = setup([
      profile('1'),
      profile('2'),
      profile('p', { protected: true }),
      profile('0', { tweetCount: 0 }),
      profile('f'),
    ]);
    cache.recordLastPost('f', { status: 'ok', postedAt: Date.now() - DAY });
    await tick();
    await press(stdin, 'a');
    expect(lastFrame()).toContain('Fetch last tweets for all stale accounts');
    expect(lastFrame()).toContain('About $0.05 for ~2 accounts');

    await press(stdin, 'n');
    expect(fetch).not.toHaveBeenCalled();
    expect(lastFrame()).toContain('@user1');
  });

  test('confirming fetches each stale account, shows a summary, and the table shows the dates', async () => {
    const { stdin, lastFrame, fetchedIds, line } = setup([profile('1'), profile('0', { tweetCount: 0 }), profile('2')]);
    await tick();
    await press(stdin, 'a');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Checked 3 accounts'));
    expect(lastFrame()).toContain('2 fetched');
    expect(fetchedIds()).toEqual(['1', '2']);

    await press(stdin, ' ');
    expect(line('user1')).toContain('2026-04-05');
    expect(line('user0')).toContain('no posts');
  });

  test('esc stops the run and keeps what was fetched; pressing a again resumes', async () => {
    const { stdin, lastFrame, fetch, fetchedIds, cache } = setup(['1', '2', '3'].map((id) => profile(id)));
    let release!: () => void;
    fetch.mockImplementationOnce(async () => tweets());
    fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => (release = () => resolve(tweets()))));
    await tick();
    await press(stdin, 'a');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(lastFrame()).toMatch(/1 of 3/);

    await press(stdin, ESC);
    release();
    await vi.waitFor(() => expect(lastFrame()).toContain('Stopped after 2 of 3 accounts'));
    expect(cache.staleAccounts().map((a) => a.id)).toEqual(['3']);

    await press(stdin, ' ');
    await press(stdin, 'a');
    expect(lastFrame()).toContain('About $0.03 for ~1 account');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Checked 1 account'));
    expect(fetchedIds()).toEqual(['1', '2', '3']);
  });

  test("uses the app's inactivity threshold to decide what is stale", async () => {
    // Last posted 200 days ago, checked 40 days ago: stale if that counts as active (30-day
    // recheck), fresh if it counts as inactive (90-day recheck).
    let t = Date.now() - 40 * DAY;
    const cache = openCache({ path: ':memory:', now: () => t });
    cache.applyFollowing([profile('1'), profile('2')]);
    cache.recordLastPost('1', { status: 'ok', postedAt: t - 160 * DAY });
    t = Date.now();
    const fetch = vi.fn(async () => tweets());
    const client = { fetch, tokens: {} } as unknown as XClient;
    const { stdin, lastFrame } = render(
      <App client={client} cache={cache} userId="42" height={10} inactiveAfterMs={100 * DAY} />,
    );
    await tick();
    await press(stdin, 'a');
    expect(lastFrame()).toContain('About $0.03 for ~1 account');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Checked 1 account'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('a run that needs no calls still asks first, at no cost', async () => {
    const { stdin, lastFrame, fetch, line } = setup([profile('0', { tweetCount: 0 })]);
    await tick();
    await press(stdin, 'a');
    expect(lastFrame()).toContain('Fetch last tweets for all stale accounts');
    expect(lastFrame()).toContain('$0.00, no API calls needed');
    await press(stdin, 'n');
    expect(line('user0')).toContain('unknown');

    await press(stdin, 'a');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Checked 1 account'));
    await press(stdin, ' ');
    expect(line('user0')).toContain('no posts');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('with nothing stale, says so without asking', async () => {
    const { stdin, lastFrame, fetch, cache } = setup([profile('1')]);
    cache.recordLastPost('1', { status: 'ok', postedAt: Date.now() - DAY });
    await tick();
    await press(stdin, 'a');
    expect(lastFrame()).toContain('Nothing to fetch');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Fetch marked rows (space, b)', () => {
  test('space marks rows, b fetches only the marked ones, and the marks clear afterwards', async () => {
    const { stdin, lastFrame, fetchedIds, line } = setup(['1', '2', '3'].map((id) => profile(id)));
    await tick();
    await press(stdin, ' '); // marks user1 and moves to user2
    await press(stdin, DOWN);
    await press(stdin, ' '); // marks user3
    expect(line('user1')).toContain('●');
    expect(line('user2')).not.toContain('●');
    expect(line('user3')).toContain('●');
    expect(lastFrame()).toContain('2 marked');

    await press(stdin, 'b');
    expect(lastFrame()).toContain('Fetch last tweets for 2 marked accounts');
    expect(lastFrame()).toContain('About $0.05 for ~2 accounts');
    await press(stdin, 'y');
    await vi.waitFor(() => expect(lastFrame()).toContain('Checked 2 accounts'));
    expect(fetchedIds()).toEqual(['1', '3']);

    await press(stdin, ' ');
    expect(lastFrame()).not.toContain('●');
    expect(line('user2')).toContain('unknown');
  });

  test('space on a marked row unmarks it', async () => {
    const { stdin, line } = setup(['1', '2'].map((id) => profile(id)));
    await tick();
    await press(stdin, ' ');
    await press(stdin, '\u001B[A');
    await press(stdin, ' ');
    expect(line('user1')).not.toContain('●');
  });

  test('b with nothing marked explains how to mark rows', async () => {
    const { stdin, lastFrame, fetch } = setup([profile('1')]);
    await tick();
    await press(stdin, 'b');
    expect(lastFrame()).toContain('Mark rows with space');
    expect(fetch).not.toHaveBeenCalled();
  });
});
