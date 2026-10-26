import { render } from 'ink-testing-library';
import { describe, expect, test, vi } from 'vitest';
import type { FollowedAccount } from '../../src/cache/index.js';
import { DetailPane } from '../../src/components/detail-pane.js';
import { FollowingTable } from '../../src/components/following-table.js';

const account = (overrides: Partial<FollowedAccount> = {}): FollowedAccount => ({
  id: '1',
  handle: 'ada',
  name: 'Ada Lovelace',
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

/** The value printed after a field's label on its line, without the pane's border. */
function field(frame: string, label: string): string | undefined {
  const line = frame
    .split('\n')
    .map((l) => l.replace(/^[\s│]+|[\s│]+$/g, ''))
    .find((l) => l.startsWith(`${label} `));
  return line?.slice(label.length).trim();
}

describe('DetailPane', () => {
  test('shows every profile field from the cache', () => {
    const { lastFrame } = render(
      <DetailPane
        account={account({
          bio: 'First programmer',
          location: 'London',
          createdAt: '2009-03-14T12:00:00.000Z',
          verified: true,
          protected: true,
          followersCount: 12345,
          followingCount: 67,
          tweetCount: 890,
          followsBack: false,
          lastPost: { status: 'ok', postedAt: Date.parse('2026-02-03T10:00:00Z'), checkedAt: 0 },
        })}
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Ada Lovelace');
    expect(frame).toContain('@ada');
    expect(field(frame, 'Bio')).toBe('First programmer');
    expect(field(frame, 'Location')).toBe('London');
    expect(field(frame, 'Joined')).toBe('2009-03-14');
    expect(field(frame, 'Verified')).toBe('yes');
    expect(field(frame, 'Protected')).toBe('yes');
    expect(field(frame, 'Followers')).toBe('12,345');
    expect(field(frame, 'Following')).toBe('67');
    expect(field(frame, 'Posts')).toBe('890');
    expect(field(frame, 'Follows you back')).toBe('no');
    expect(field(frame, 'Last tweet')).toBe('2026-02-03');
  });

  test('shows "unknown" for missing values, never a blank', () => {
    const frame = render(<DetailPane account={account()} />).lastFrame() ?? '';
    for (const label of ['Bio', 'Location', 'Joined', 'Followers', 'Following', 'Posts', 'Follows you back', 'Last tweet']) {
      expect(field(frame, label), label).toBe('unknown');
    }
    expect(field(frame, 'Verified')).toBe('no');
    expect(field(frame, 'Protected')).toBe('no');
  });

  test('labels a suspended account and its last tweet', () => {
    const frame = render(<DetailPane account={account({ suspended: true })} />).lastFrame() ?? '';
    expect(field(frame, 'Suspended')).toBe('yes');
    expect(field(frame, 'Last tweet')).toBe('suspended');
  });
});

describe('FollowingTable detail pane', () => {
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const ENTER = '\r';
  const ESC = '\u001B';
  const DOWN = '\u001B[B';

  function setup(accounts: FollowedAccount[]) {
    const onQuit = vi.fn();
    const onRefresh = vi.fn();
    const app = render(
      <FollowingTable
        accounts={accounts}
        removed={[]}
        hasFollowers
        height={5}
        onQuit={onQuit}
        onRefresh={onRefresh}
        onRefreshFollowers={vi.fn()}
        onFetchLastPost={vi.fn(async () => '')}
        onFetchStale={vi.fn()}
        onFetchMarked={vi.fn()}
        onUnfollow={vi.fn()}
        onOpenProfile={vi.fn()}
      />,
    );
    const press = async (...keys: string[]) => {
      for (const key of keys) {
        app.stdin.write(key);
        await tick();
      }
    };
    const frame = () => app.lastFrame() ?? '';
    const highlighted = () => frame().match(/❯ @(\S+)/)?.[1];
    return { frame, press, highlighted, onQuit, onRefresh };
  }

  // Only bea doesn't follow back, so the filter would visibly change the count.
  const accounts = ['amy', 'bob', 'bea', 'cat'].map((handle) =>
    account({ id: handle, handle, name: `${handle} name`, bio: `${handle}'s bio`, followsBack: handle !== 'bea' }),
  );

  test('Enter opens the highlighted account and Esc returns to the same row', async () => {
    const { frame, press, highlighted } = setup(accounts);
    await press(DOWN, DOWN, ENTER); // amy, bea, bob
    expect(frame()).toContain("bob's bio");
    expect(frame()).not.toContain('❯');
    await press(ESC);
    expect(frame()).not.toContain("bob's bio");
    expect(highlighted()).toBe('bob');
  });

  test('table keys do nothing while the pane is open, and search, sort and filter survive it', async () => {
    const { frame, press, highlighted, onRefresh } = setup(accounts);
    await press('/', 'b', ENTER, '1', DOWN); // search "b", handle descending: bob, bea
    expect(highlighted()).toBe('bea');
    await press(ENTER, DOWN, '2', 'f', '/', 'r', ESC);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(highlighted()).toBe('bea');
    expect(frame()).toContain('/b');
    expect(frame()).toContain('Handle ▼');
    expect(frame()).toContain('2 of 4 accounts');
  });

  test('q still quits while the pane is open', async () => {
    const { press, onQuit } = setup(accounts);
    await press(ENTER, 'q');
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  test('Enter does nothing when no row matches', async () => {
    const { frame, press } = setup(accounts);
    await press('/', 'z', ENTER, ENTER);
    expect(frame()).toContain('No accounts match.');
  });
});
