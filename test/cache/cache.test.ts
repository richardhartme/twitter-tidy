import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, onTestFinished, test } from 'vitest';
import {
  DEFAULT_INACTIVITY_MS,
  defaultCachePath,
  openCache,
  type AccountProfile,
  type Cache,
  type LastPostResult,
} from '../../src/cache/index.js';

const DAY = 86_400_000;

const profile = (id: string, extra: Partial<AccountProfile> = {}): AccountProfile => ({
  id,
  handle: `user${id}`,
  name: `User ${id}`,
  bio: '',
  location: null,
  createdAt: '2015-01-01T00:00:00.000Z',
  verified: false,
  protected: false,
  suspended: false,
  followersCount: 10,
  followingCount: 20,
  tweetCount: 30,
  ...extra,
});

function setup(start = 1_000 * DAY) {
  let t = start;
  const clock = { now: () => t, advance: (ms: number) => (t += ms), set: (ms: number) => (t = ms) };
  return { clock, cache: openCache({ path: ':memory:', now: clock.now }) };
}

describe('openCache on a file', () => {
  test('creates the directory and schema, and reopening keeps data without re-migrating', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tt-cache-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, 'nested');
    const path = join(dir, 'cache.db');
    const first = openCache({ path, now: () => 1 });
    const version = first.schemaVersion;
    expect(version).toBeGreaterThanOrEqual(1);
    first.applyFollowing([profile('1')]);
    first.close();
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    const second = openCache({ path, now: () => 2 });
    expect(second.schemaVersion).toBe(version);
    expect(second.listFollowing().map((r) => r.id)).toEqual(['1']);
    second.close();
  });

  test('defaults to cache.db beside the token file', () => {
    expect(defaultCachePath()).toMatch(/\.config[\\/]twittertidy[\\/]cache\.db$/);
  });
});

describe('applyFollowing', () => {
  test('first refresh on an empty cache adds every account without marking any new', () => {
    const { cache } = setup();
    const result = cache.applyFollowing([profile('1'), profile('2')]);
    expect(result).toEqual({ added: ['1', '2'], removed: [], restored: [] });
    const rows = cache.listFollowing();
    expect(rows.map((r) => [r.id, r.handle, r.isNew])).toEqual([
      ['1', 'user1', false],
      ['2', 'user2', false],
    ]);
  });

  test('a pull after an empty one still marks its additions new', () => {
    const { cache } = setup();
    cache.applyFollowing([]);
    cache.applyFollowing([profile('1')]);
    expect(cache.listFollowing().map((r) => [r.id, r.isNew])).toEqual([['1', false]]);
    cache.applyFollowing([profile('1'), profile('2')]);
    expect(cache.listFollowing().map((r) => [r.id, r.isNew])).toEqual([
      ['1', false],
      ['2', true],
    ]);
  });

  test('second refresh clears previous new marks and marks only first-seen accounts', () => {
    const { cache } = setup();
    cache.applyFollowing([profile('1'), profile('2')]);
    const result = cache.applyFollowing([profile('1'), profile('2'), profile('3')]);
    expect(result).toEqual({ added: ['3'], removed: [], restored: [] });
    expect(cache.listFollowing().map((r) => [r.id, r.isNew])).toEqual([
      ['1', false],
      ['2', false],
      ['3', true],
    ]);
  });

  test('accounts missing from a refresh are soft-removed and stay visible as removed', () => {
    const { cache, clock } = setup();
    cache.applyFollowing([profile('1'), profile('2')]);
    clock.advance(DAY);
    const result = cache.applyFollowing([profile('1')]);
    expect(result).toEqual({ added: [], removed: ['2'], restored: [] });
    expect(cache.listFollowing().map((r) => r.id)).toEqual(['1']);
    expect(cache.listRemoved().map((r) => [r.id, r.handle, r.removedAt])).toEqual([['2', 'user2', clock.now()]]);
  });

  test('only accounts removed by the latest refresh count as recently removed', () => {
    const { cache, clock } = setup();
    const recent = () => cache.listRemoved().map((r) => [r.id, r.recentlyRemoved]);
    cache.applyFollowing([profile('1'), profile('2'), profile('3')]);
    clock.advance(DAY);
    cache.applyFollowing([profile('1'), profile('3')]);
    expect(recent()).toEqual([['2', true]]);

    clock.advance(DAY);
    cache.applyFollowing([profile('1')]);
    expect(recent()).toEqual([
      ['3', true],
      ['2', false],
    ]);

    clock.advance(DAY);
    cache.applyFollowing([profile('1')]);
    expect(recent()).toEqual([
      ['3', false],
      ['2', false],
    ]);
  });

  test('a removed account that reappears is restored, not new, with its profile updated', () => {
    const { cache } = setup();
    cache.applyFollowing([profile('1'), profile('2')]);
    cache.applyFollowing([profile('1')]);
    const result = cache.applyFollowing([profile('1'), profile('2', { handle: 'renamed', followersCount: 99 })]);
    expect(result).toEqual({ added: [], removed: [], restored: ['2'] });
    expect(cache.listRemoved()).toEqual([]);
    expect(cache.listFollowing().map((r) => [r.id, r.handle, r.followersCount, r.isNew])).toEqual([
      ['2', 'renamed', 99, false],
      ['1', 'user1', 10, false],
    ]);
  });
});

describe('followers', () => {
  const followsBack = (cache: Cache) =>
    cache.listFollowing().map((r) => [r.id, r.followsBack]);

  test('follows-back is unknown until the followers list has been pulled', () => {
    const { cache } = setup();
    cache.applyFollowing([profile('1'), profile('2')]);
    expect(cache.hasFollowers()).toBe(false);
    expect(followsBack(cache)).toEqual([
      ['1', null],
      ['2', null],
    ]);
  });

  test('replacing the followers list changes follows-back', () => {
    const { cache } = setup();
    cache.applyFollowing([profile('1'), profile('2')]);
    cache.replaceFollowers(['1', '999']);
    expect(cache.hasFollowers()).toBe(true);
    expect(followsBack(cache)).toEqual([
      ['1', true],
      ['2', false],
    ]);
    cache.replaceFollowers(['2']);
    expect(followsBack(cache)).toEqual([
      ['1', false],
      ['2', true],
    ]);
  });

  test('an empty followers pull still counts as pulled', () => {
    const { cache } = setup();
    cache.applyFollowing([profile('1')]);
    cache.replaceFollowers([]);
    expect(cache.hasFollowers()).toBe(true);
    expect(followsBack(cache)).toEqual([['1', false]]);
  });
});

describe('recordLastPost', () => {
  test('last post is unknown until recorded, then carries status, date and check time', () => {
    const { cache, clock } = setup();
    cache.applyFollowing([profile('1'), profile('2')]);
    expect(cache.listFollowing().map((r) => r.lastPost)).toEqual([null, null]);
    const postedAt = clock.now() - 3 * DAY;
    cache.recordLastPost('1', { status: 'ok', postedAt });
    clock.advance(DAY);
    cache.recordLastPost('2', { status: 'protected' });
    expect(cache.listFollowing().map((r) => r.lastPost)).toEqual([
      { status: 'ok', postedAt, checkedAt: clock.now() - DAY },
      { status: 'protected', postedAt: null, checkedAt: clock.now() },
    ]);
  });

  test('recording again overwrites the previous result', () => {
    const { cache, clock } = setup();
    cache.applyFollowing([profile('1')]);
    cache.recordLastPost('1', { status: 'no_posts' });
    clock.advance(DAY);
    cache.recordLastPost('1', { status: 'ok', postedAt: 5 });
    expect(cache.listFollowing()[0]?.lastPost).toEqual({ status: 'ok', postedAt: 5, checkedAt: clock.now() });
  });
});

describe('staleAccounts', () => {
  const NOW = 2_000 * DAY;

  const daysAgo = (days: number) => NOW - days * DAY;
  const posted = (days: number): LastPostResult => ({ status: 'ok', postedAt: daysAgo(days) });

  /** Records a last-post check made `checkedDaysAgo` before NOW. */
  function recordCheck({ cache, clock }: ReturnType<typeof setup>, id: string, checkedDaysAgo: number, result: LastPostResult) {
    clock.set(daysAgo(checkedDaysAgo));
    cache.recordLastPost(id, result);
    clock.set(NOW);
  }

  const staleIds = (ctx: ReturnType<typeof setup>, threshold?: number) =>
    ctx.cache.staleAccounts(threshold === undefined ? undefined : { inactiveAfterMs: threshold }).map((a) => a.id);

  test('the default inactivity threshold is 12 months', () => {
    expect(DEFAULT_INACTIVITY_MS).toBe(365 * DAY);
  });

  test('never-checked accounts are stale', () => {
    const ctx = setup(NOW);
    ctx.cache.applyFollowing([profile('1')]);
    expect(staleIds(ctx)).toEqual(['1']);
  });

  test('active accounts go stale after 30 days', () => {
    const ctx = setup(NOW);
    ctx.cache.applyFollowing([profile('fresh'), profile('stale')]);
    recordCheck(ctx, 'fresh', 29, posted(10));
    recordCheck(ctx, 'stale', 31, posted(10));
    expect(staleIds(ctx)).toEqual(['stale']);
  });

  test('inactive and no-posts accounts go stale after 90 days', () => {
    const ctx = setup(NOW);
    ctx.cache.applyFollowing([profile('inactive89'), profile('inactive91'), profile('none89'), profile('none91')]);
    recordCheck(ctx, 'inactive89', 89, posted(400));
    recordCheck(ctx, 'inactive91', 91, posted(400));
    recordCheck(ctx, 'none89', 89, { status: 'no_posts' });
    recordCheck(ctx, 'none91', 91, { status: 'no_posts' });
    expect(staleIds(ctx).sort()).toEqual(['inactive91', 'none91']);
  });

  test('the inactivity threshold decides which limit applies', () => {
    const ctx = setup(NOW);
    ctx.cache.applyFollowing([profile('1')]);
    recordCheck(ctx, '1', 60, posted(100));
    expect(staleIds(ctx)).toEqual(['1']);
    expect(staleIds(ctx, 90 * DAY)).toEqual([]);
  });

  test('protected, suspended and removed accounts are never stale', () => {
    const ctx = setup(NOW);
    ctx.cache.applyFollowing([
      profile('prot', { protected: true }),
      profile('susp', { suspended: true }),
      profile('protChecked'),
      profile('suspChecked'),
      profile('removed'),
    ]);
    recordCheck(ctx, 'protChecked', 1000, { status: 'protected' });
    recordCheck(ctx, 'suspChecked', 1000, { status: 'suspended' });
    ctx.cache.applyFollowing([
      profile('prot', { protected: true }),
      profile('susp', { suspended: true }),
      profile('protChecked'),
      profile('suspChecked'),
    ]);
    expect(staleIds(ctx)).toEqual([]);
  });

  describe('isStale', () => {
    test('agrees with staleAccounts for one account, at the 30- and 90-day boundaries', () => {
      const ctx = setup(NOW);
      const ids = ['never', 'active29', 'active31', 'inactive89', 'inactive91', 'none89', 'none91', 'prot', 'protChecked'];
      ctx.cache.applyFollowing(ids.map((id) => profile(id, { protected: id === 'prot' })));
      recordCheck(ctx, 'active29', 29, posted(10));
      recordCheck(ctx, 'active31', 31, posted(10));
      recordCheck(ctx, 'inactive89', 89, posted(400));
      recordCheck(ctx, 'inactive91', 91, posted(400));
      recordCheck(ctx, 'none89', 89, { status: 'no_posts' });
      recordCheck(ctx, 'none91', 91, { status: 'no_posts' });
      recordCheck(ctx, 'protChecked', 1000, { status: 'protected' });
      expect(ids.filter((id) => ctx.cache.isStale(id))).toEqual(['never', 'active31', 'inactive91', 'none91']);
    });

    test('honours the inactivity threshold, and unknown or removed accounts are not stale', () => {
      const ctx = setup(NOW);
      ctx.cache.applyFollowing([profile('1'), profile('gone')]);
      ctx.cache.applyFollowing([profile('1')]);
      recordCheck(ctx, '1', 60, posted(100));
      expect(ctx.cache.isStale('1')).toBe(true);
      expect(ctx.cache.isStale('1', { inactiveAfterMs: 90 * DAY })).toBe(false);
      expect(ctx.cache.isStale('gone')).toBe(false);
      expect(ctx.cache.isStale('nobody')).toBe(false);
    });
  });
});
