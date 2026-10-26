import { render } from 'ink-testing-library';
import { describe, expect, test, vi } from 'vitest';
import type { FollowedAccount, LastPost } from '../../src/cache/index.js';
import { FollowingTable } from '../../src/components/following-table.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-25T12:00:00Z');
const tick = () => new Promise((r) => setTimeout(r, 20));
const ENTER = '\r';

const posted = (daysAgo: number): LastPost => ({ status: 'ok', postedAt: NOW - daysAgo * DAY, checkedAt: NOW });
const noPosts: LastPost = { status: 'no_posts', postedAt: null, checkedAt: NOW };

const account = (handle: string, overrides: Partial<FollowedAccount> = {}): FollowedAccount => ({
  id: handle,
  handle,
  name: `${handle} name`,
  bio: null,
  location: null,
  createdAt: null,
  verified: false,
  protected: false,
  suspended: false,
  followersCount: null,
  followingCount: null,
  tweetCount: null,
  isNew: false,
  followsBack: null,
  lastPost: null,
  ...overrides,
});

function setup(accounts: FollowedAccount[], { inactiveAfterMs }: { inactiveAfterMs?: number } = {}) {
  const app = render(
    <FollowingTable
      accounts={accounts}
      removed={[]}
      hasFollowers
      height={10}
      onQuit={vi.fn()}
      onRefresh={vi.fn()}
      onRefreshFollowers={vi.fn()}
      onFetchLastPost={vi.fn(async () => '')}
      onFetchStale={vi.fn()}
      onFetchMarked={vi.fn()}
      onUnfollow={vi.fn()}
      onOpenProfile={vi.fn()}
      inactiveAfterMs={inactiveAfterMs}
      now={() => NOW}
    />,
  );
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      app.stdin.write(key);
      await tick();
    }
  };
  const lines = () => (app.lastFrame() ?? '').split('\n');
  const rows = () => lines().map((l) => l.match(/@(\S+)/)?.[1]).filter((h): h is string => h !== undefined);
  const row = (handle: string) => lines().find((l) => l.includes(`@${handle} `)) ?? '';
  return { ...app, press, rows, row };
}

const mixed = () => [
  account('active', { lastPost: posted(10), followsBack: false }),
  account('dormant', { lastPost: posted(400), followsBack: false }),
  account('silent', { lastPost: noPosts, followsBack: true }),
  account('unchecked', { followsBack: false }),
];

describe('FollowingTable inactive flag', () => {
  test('marks inactive accounts, and never unknown ones', () => {
    const { row } = setup(mixed());
    expect(row('dormant')).toContain('inactive');
    expect(row('silent')).toContain('inactive');
    expect(row('active')).not.toContain('inactive');
    expect(row('unchecked')).not.toContain('inactive');
  });

  test('uses the threshold it is given', () => {
    const { row } = setup(mixed(), { inactiveAfterMs: 5 * DAY });
    expect(row('active')).toContain('inactive');
  });

  test('i toggles inactive-only, and the status bar says so', async () => {
    const { rows, press, lastFrame } = setup(mixed());
    await press('i');
    expect(rows()).toEqual(['dormant', 'silent']);
    expect(lastFrame()).toContain('Inactive only');
    await press('i');
    expect(rows()).toEqual(['active', 'dormant', 'silent', 'unchecked']);
    expect(lastFrame()).not.toContain('Inactive only');
  });

  test('i combines with the follow-back filter, search and sort', async () => {
    const accounts = [...mixed(), account('dusty', { lastPost: posted(800), followsBack: false })];
    const { rows, press } = setup(accounts);
    await press('i', 'f');
    expect(rows()).toEqual(['dormant', 'dusty']);
    await press('3');
    expect(rows()).toEqual(['dusty', 'dormant']);
    await press('/', 'm', 'a', 'n', ENTER);
    expect(rows()).toEqual(['dormant']);
  });

  test('i is search text while typing a search', async () => {
    const { rows, press, lastFrame } = setup(mixed());
    await press('/', 'i');
    expect(rows()).toEqual(['active', 'silent']);
    expect(lastFrame()).not.toContain('Inactive only');
  });

  test('the key hints list i', () => {
    const { lastFrame } = setup(mixed());
    expect(lastFrame()).toContain('i inactive');
  });
});
