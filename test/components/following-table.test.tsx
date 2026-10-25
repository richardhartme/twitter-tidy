import { render } from 'ink-testing-library';
import { describe, expect, test, vi } from 'vitest';
import type { FollowedAccount, RemovedAccount } from '../../src/cache/index.js';
import { FollowingTable } from '../../src/components/following-table.js';

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

const tick = () => new Promise((r) => setTimeout(r, 20));
const ENTER = '\r';
const ESC = '\u001B';
const DOWN = '\u001B[B';
const UP = '\u001B[A';
const PAGE_DOWN = '\u001B[6~';
const BACKSPACE = '\u007F';

const removedAccount = (handle: string, removedAt: string, recentlyRemoved = false): RemovedAccount => {
  const { isNew: _isNew, followsBack: _followsBack, lastPost: _lastPost, ...profile } = account(handle);
  return { ...profile, removedAt: Date.parse(removedAt), recentlyRemoved };
};

function setup(
  accounts: FollowedAccount[],
  { hasFollowers = true, height = 5, removed = [] as RemovedAccount[] } = {},
) {
  const onQuit = vi.fn();
  const onRefresh = vi.fn();
  const onRefreshFollowers = vi.fn();
  const onFetchLastPost = vi.fn(async (a: FollowedAccount) => `checked @${a.handle}`);
  const onOpenProfile = vi.fn();
  const app = render(
    <FollowingTable
      accounts={accounts}
      removed={removed}
      hasFollowers={hasFollowers}
      height={height}
      onQuit={onQuit}
      onRefresh={onRefresh}
      onRefreshFollowers={onRefreshFollowers}
      onFetchLastPost={onFetchLastPost}
      onFetchStale={vi.fn()}
      onFetchMarked={vi.fn()}
      onOpenProfile={onOpenProfile}
    />,
  );
  const press = async (...keys: string[]) => {
    for (const key of keys) {
      app.stdin.write(key);
      await tick();
    }
  };
  /** The handles of the rendered rows, top to bottom. */
  const rows = () =>
    (app.lastFrame() ?? '')
      .split('\n')
      .map((line) => line.match(/@(\S+)/)?.[1])
      .filter((h): h is string => h !== undefined);
  const highlighted = () => (app.lastFrame() ?? '').match(/❯ @(\S+)/)?.[1];
  return { ...app, press, rows, highlighted, onQuit, onRefresh, onRefreshFollowers, onFetchLastPost, onOpenProfile };
}

describe('FollowingTable', () => {
  test('shows each column, with unknown values as "unknown"', () => {
    const { lastFrame } = setup([
      account('known', {
        followsBack: true,
        followersCount: 1234,
        followingCount: 56,
        lastPost: { status: 'ok', postedAt: Date.parse('2026-02-03T10:00:00Z'), checkedAt: 0 },
      }),
      account('mystery'),
    ]);
    const frame = lastFrame() ?? '';
    for (const heading of ['Handle', 'Follows back', 'Last tweet', 'Followers', 'Following']) {
      expect(frame).toContain(heading);
    }
    const [known, mystery] = ['@known', '@mystery'].map((h) => frame.split('\n').find((l) => l.includes(h)) ?? '');
    expect(known).toMatch(/yes.*2026-02-03.*1,234.*56/);
    expect(mystery).toMatch(/unknown.*unknown.*unknown.*unknown/);
  });

  test('renders only a window of rows, and the highlight scrolls it', async () => {
    const accounts = Array.from({ length: 3000 }, (_, i) => account(`u${String(i).padStart(4, '0')}`));
    const { rows, highlighted, press } = setup(accounts, { height: 3 });
    expect(rows()).toEqual(['u0000', 'u0001', 'u0002']);
    expect(highlighted()).toBe('u0000');

    await press(DOWN, DOWN, DOWN);
    expect(highlighted()).toBe('u0003');
    expect(rows()).toEqual(['u0001', 'u0002', 'u0003']);

    await press(UP, UP, UP);
    expect(highlighted()).toBe('u0000');
    expect(rows()).toEqual(['u0000', 'u0001', 'u0002']);

    await press(UP);
    expect(highlighted()).toBe('u0000');
  });

  test('PgDn and PgUp move a page at a time and stop at the ends', async () => {
    const accounts = Array.from({ length: 10 }, (_, i) => account(`u${i}`));
    const { rows, highlighted, press } = setup(accounts, { height: 4 });
    await press(PAGE_DOWN);
    expect(highlighted()).toBe('u4');
    await press(PAGE_DOWN, PAGE_DOWN);
    expect(highlighted()).toBe('u9');
    expect(rows()).toEqual(['u6', 'u7', 'u8', 'u9']);
    await press(DOWN);
    expect(highlighted()).toBe('u9');
    await press('\u001B[5~');
    expect(highlighted()).toBe('u5');
  });

  test('number keys sort by column, the same key again reverses, and the heading shows the sort', async () => {
    const accounts = [
      account('alpha', { followersCount: 20, followingCount: 1, followsBack: true }),
      account('bravo', { followersCount: 300, followingCount: 3, followsBack: false }),
      account('charlie', { followersCount: 1, followingCount: 2, followsBack: null }),
    ];
    const { rows, press, lastFrame } = setup(accounts);
    expect(rows()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(lastFrame()).toContain('Handle ▲');

    await press('4');
    expect(rows()).toEqual(['charlie', 'alpha', 'bravo']);
    expect(lastFrame()).toContain('Followers ▲');
    await press('4');
    expect(rows()).toEqual(['bravo', 'alpha', 'charlie']);
    expect(lastFrame()).toContain('Followers ▼');

    await press('5');
    expect(rows()).toEqual(['alpha', 'charlie', 'bravo']);
    await press('2');
    expect(rows()).toEqual(['bravo', 'alpha', 'charlie']);
    await press('1', '1');
    expect(rows()).toEqual(['charlie', 'bravo', 'alpha']);
  });

  test('sorts last tweet with key 3', async () => {
    const at = (iso: string) => ({ status: 'ok' as const, postedAt: Date.parse(iso), checkedAt: 0 });
    const { rows, press } = setup([
      account('new', { lastPost: at('2026-09-01') }),
      account('unchecked'),
      account('old', { lastPost: at('2023-01-01') }),
    ]);
    await press('3');
    expect(rows()).toEqual(['old', 'new', 'unchecked']);
  });

  test('/ searches handle and name live; Enter keeps the search and Esc clears it', async () => {
    const { rows, press, lastFrame, onQuit } = setup([
      account('alice', { name: 'Alice Quill' }),
      account('bob', { name: 'Bob Stone' }),
      account('quentin', { name: 'Q' }),
    ]);
    await press('/', 'Q', 'u');
    expect(rows()).toEqual(['alice', 'quentin']);
    expect(lastFrame()).toContain('/Qu');

    await press('i');
    expect(rows()).toEqual(['alice']);
    await press(BACKSPACE);
    expect(rows()).toEqual(['alice', 'quentin']);

    // While typing, q and the sort keys are search text.
    await press('q');
    expect(onQuit).not.toHaveBeenCalled();
    expect(rows()).toEqual([]);
    expect(lastFrame()).toContain('No accounts match');
    await press(BACKSPACE, ENTER);
    expect(rows()).toEqual(['alice', 'quentin']);

    // Kept: keys act on the table again.
    await press('1');
    expect(rows()).toEqual(['quentin', 'alice']);

    await press('/', ESC);
    expect(rows()).toEqual(['quentin', 'bob', 'alice']);
    expect(lastFrame()).not.toContain('/Qu');
  });

  test('f toggles "doesn\'t follow back", combining with search and sort', async () => {
    const { rows, press, lastFrame } = setup([
      account('dev_ann', { followsBack: false, followersCount: 10 }),
      account('dev_ben', { followsBack: false, followersCount: 99 }),
      account('dev_cat', { followsBack: true, followersCount: 50 }),
      account('ops_dan', { followsBack: false, followersCount: 70 }),
      account('dev_eve', { followsBack: null, followersCount: 80 }),
    ]);
    await press('f');
    expect(rows()).toEqual(['dev_ann', 'dev_ben', 'ops_dan']);
    expect(lastFrame()).toContain("Doesn't follow back");

    await press('/', 'd', 'e', 'v', ENTER, '4', '4');
    expect(rows()).toEqual(['dev_ben', 'dev_ann']);

    await press('f');
    expect(rows()).toEqual(['dev_ben', 'dev_eve', 'dev_cat', 'dev_ann']);
    expect(lastFrame()).not.toContain("Doesn't follow back");
  });

  test('f does not filter before followers have been pulled, and says why', async () => {
    const { rows, press, lastFrame } = setup([account('a'), account('b')], { hasFollowers: false });
    await press('f');
    expect(rows()).toEqual(['a', 'b']);
    expect(lastFrame()).toContain('Follow-back is unknown until your followers have been pulled');
  });

  test('q quits and r asks for a refresh, but not while typing a search', async () => {
    const { press, onQuit, onRefresh } = setup([account('a')]);
    await press('/', 'r', 'q', ENTER);
    expect(onQuit).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
    await press('r');
    expect(onRefresh).toHaveBeenCalledTimes(1);
    await press('q');
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  test('shows the row count and key hints', () => {
    const { lastFrame } = setup([account('a'), account('b')]);
    expect(lastFrame()).toContain('2 accounts');
    expect(lastFrame()).toContain('/ search');
    expect(lastFrame()).toContain('q quit');
  });
});

describe('FollowingTable refresh flags', () => {
  test('marks accounts that are new since the last refresh, and counts them', () => {
    const { lastFrame } = setup([account('fresh', { isNew: true }), account('old')]);
    const line = (handle: string) => (lastFrame() ?? '').split('\n').find((l) => l.includes(`@${handle}`)) ?? '';
    expect(line('fresh')).toMatch(/@fresh +new/);
    expect(line('old')).not.toContain('new');
    expect(lastFrame()).toContain('1 new');
  });

  test('x toggles a view of removed accounts with their removal dates, most recent first', async () => {
    const { press, rows, lastFrame } = setup([account('kept')], {
      removed: [removedAccount('gone2', '2026-10-20T12:00:00Z'), removedAccount('gone1', '2026-09-01T12:00:00Z')],
    });
    await press('x');
    expect(rows()).toEqual(['gone2', 'gone1']);
    expect(lastFrame()).toMatch(/@gone2 .*2026-10-20/);
    expect(lastFrame()).toMatch(/@gone1 .*2026-09-01/);
    expect(lastFrame()).toContain('2 removed accounts');

    await press('x');
    expect(rows()).toEqual(['kept']);
  });

  test('search applies in the removed view', async () => {
    const { press, rows } = setup([], {
      removed: [removedAccount('alpha', '2026-10-20T12:00:00Z'), removedAccount('beta', '2026-09-01T12:00:00Z')],
    });
    await press('x', '/', 'b', 'e', '\r');
    expect(rows()).toEqual(['beta']);
  });

  test('Enter does not open the detail pane in the removed view', async () => {
    const { press, rows } = setup([account('kept')], { removed: [removedAccount('gone', '2026-10-20T12:00:00Z')] });
    await press('x', '\r');
    expect(rows()).toEqual(['gone']);
  });

  test('says so when nothing has been removed', async () => {
    const { press, lastFrame } = setup([account('kept')]);
    await press('x');
    expect(lastFrame()).toContain('No removed accounts');
  });

  test('F asks for a followers refresh, but not while typing a search', async () => {
    const { press, onRefreshFollowers } = setup([account('a')]);
    await press('/', 'F');
    expect(onRefreshFollowers).not.toHaveBeenCalled();
    await press('\r', 'F');
    expect(onRefreshFollowers).toHaveBeenCalledTimes(1);
  });
});

describe('FollowingTable last tweet (l)', () => {
  test('l fetches the highlighted account and shows the result', async () => {
    const { press, onFetchLastPost, lastFrame } = setup([account('a'), account('b')]);
    await press(DOWN, 'l');
    expect(onFetchLastPost).toHaveBeenCalledTimes(1);
    expect(onFetchLastPost.mock.calls[0]?.[0].handle).toBe('b');
    expect(lastFrame()).toContain('checked @b');
  });

  test('l is search text while typing a search, not a fetch', async () => {
    const { press, onFetchLastPost, rows } = setup([account('alpha'), account('bob')]);
    await press('/', 'l');
    expect(onFetchLastPost).not.toHaveBeenCalled();
    expect(rows()).toEqual(['alpha']);
  });

  test('l does nothing while the detail pane is open', async () => {
    const { press, onFetchLastPost } = setup([account('a')]);
    await press(ENTER, 'l');
    expect(onFetchLastPost).not.toHaveBeenCalled();
  });

  test('l does nothing in the removed view', async () => {
    const { press, onFetchLastPost } = setup([account('kept')], { removed: [removedAccount('gone', '2026-10-20T12:00:00Z')] });
    await press('x', 'l');
    expect(onFetchLastPost).not.toHaveBeenCalled();
  });

  test('the key hints list l alongside the other keys', () => {
    const { lastFrame } = setup([account('a')]);
    for (const hint of ['l last tweet', 'x removed', 'F followers', 'enter details', 'r refresh']) {
      expect((lastFrame() ?? '').replace(/\s+/g, ' ')).toContain(hint);
    }
  });
});

describe('FollowingTable open profile (o)', () => {
  const opened = (fn: ReturnType<typeof setup>['onOpenProfile']) => fn.mock.calls.map(([a]) => a.handle);

  test('o opens the highlighted account and says so', async () => {
    const { press, onOpenProfile, lastFrame } = setup([account('a'), account('b')]);
    await press(DOWN, 'o');
    expect(opened(onOpenProfile)).toEqual(['b']);
    expect(lastFrame()).toContain('Opened @b in your browser');
  });

  test('o opens the account shown in the detail pane', async () => {
    const { press, onOpenProfile } = setup([account('a'), account('b')]);
    await press(DOWN, ENTER, 'o');
    expect(opened(onOpenProfile)).toEqual(['b']);
  });

  test('o opens the highlighted account in the removed view', async () => {
    const { press, onOpenProfile } = setup([account('kept')], { removed: [removedAccount('gone', '2026-10-20T12:00:00Z')] });
    await press('x', 'o');
    expect(opened(onOpenProfile)).toEqual(['gone']);
  });

  test('o is search text while typing a search', async () => {
    const { press, onOpenProfile, rows } = setup([account('bob'), account('otto')]);
    await press('/', 'o');
    expect(onOpenProfile).not.toHaveBeenCalled();
    expect(rows()).toEqual(['bob', 'otto']);
  });

  test('o does nothing when no rows match', async () => {
    const { press, onOpenProfile } = setup([account('a')]);
    await press('/', 'z', ENTER, 'o');
    expect(onOpenProfile).not.toHaveBeenCalled();
  });

  test('the key hints list o', async () => {
    const { lastFrame, press } = setup([account('a')]);
    expect((lastFrame() ?? '').replace(/\s+/g, ' ')).toContain('o open');
    await press(ENTER);
    expect((lastFrame() ?? '').replace(/\s+/g, ' ')).toContain('o open');
  });
});
