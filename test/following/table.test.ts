import { describe, expect, test } from 'vitest';
import type { FollowedAccount } from '../../src/cache/index.js';
import { formatCount, formatFollowsBack, formatLastPost, viewRows, type ViewOptions } from '../../src/following/index.js';

const day = (iso: string) => Date.parse(`${iso}T12:00:00Z`);

const account = (handle: string, overrides: Partial<FollowedAccount> = {}): FollowedAccount => ({
  id: handle,
  handle,
  name: handle.toUpperCase(),
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

const ok = (iso: string) => ({ status: 'ok' as const, postedAt: day(iso), checkedAt: day('2026-10-01') });
const status = (s: 'no_posts' | 'protected' | 'suspended') => ({ status: s, postedAt: null, checkedAt: day('2026-10-01') });

const defaults: ViewOptions = { sort: { key: 'handle', descending: false }, search: '', notFollowingBack: false };
const handles = (accounts: FollowedAccount[], options: Partial<ViewOptions> = {}) =>
  viewRows(accounts, { ...defaults, ...options }).map((a) => a.handle);

describe('viewRows sorting', () => {
  test('sorts handles case-insensitively, and reversing flips the order', () => {
    const accounts = [account('bob'), account('Alice'), account('carol')];
    expect(handles(accounts)).toEqual(['Alice', 'bob', 'carol']);
    expect(handles(accounts, { sort: { key: 'handle', descending: true } })).toEqual(['carol', 'bob', 'Alice']);
  });

  test('sorts follower counts with unknown counts last in both directions', () => {
    const accounts = [
      account('a', { followersCount: 50 }),
      account('b', { followersCount: null }),
      account('c', { followersCount: 7 }),
      account('d', { followersCount: 900 }),
    ];
    expect(handles(accounts, { sort: { key: 'followers', descending: false } })).toEqual(['c', 'a', 'd', 'b']);
    expect(handles(accounts, { sort: { key: 'followers', descending: true } })).toEqual(['d', 'a', 'c', 'b']);
  });

  test('sorts following counts', () => {
    const accounts = [account('a', { followingCount: 3 }), account('b', { followingCount: 1 })];
    expect(handles(accounts, { sort: { key: 'following', descending: false } })).toEqual(['b', 'a']);
  });

  test('sorts last tweet oldest first, with unknown and non-date statuses last in both directions', () => {
    const accounts = [
      account('recent', { lastPost: ok('2026-09-01') }),
      account('never', { lastPost: null }),
      account('old', { lastPost: ok('2024-01-15') }),
      account('locked', { lastPost: status('protected') }),
      account('quiet', { lastPost: status('no_posts') }),
    ];
    const asc = handles(accounts, { sort: { key: 'lastTweet', descending: false } });
    expect(asc.slice(0, 2)).toEqual(['old', 'recent']);
    expect(asc.slice(2).sort()).toEqual(['locked', 'never', 'quiet']);
    const desc = handles(accounts, { sort: { key: 'lastTweet', descending: true } });
    expect(desc.slice(0, 2)).toEqual(['recent', 'old']);
  });

  test('sorts "doesn\'t follow back" first, with unknown last in both directions', () => {
    const accounts = [
      account('yes', { followsBack: true }),
      account('unknown', { followsBack: null }),
      account('no', { followsBack: false }),
    ];
    expect(handles(accounts, { sort: { key: 'followsBack', descending: false } })).toEqual(['no', 'yes', 'unknown']);
    expect(handles(accounts, { sort: { key: 'followsBack', descending: true } })).toEqual(['yes', 'no', 'unknown']);
  });

  test('breaks ties by handle', () => {
    const accounts = [account('b', { followersCount: 1 }), account('a', { followersCount: 1 })];
    expect(handles(accounts, { sort: { key: 'followers', descending: true } })).toEqual(['a', 'b']);
  });
});

describe('viewRows search and filter', () => {
  test('search matches handle or name, case-insensitively', () => {
    const accounts = [
      account('alice', { name: 'Alice Smith' }),
      account('bob', { name: 'Robert SMITHERS' }),
      account('carol', { name: 'Carol Jones' }),
    ];
    expect(handles(accounts, { search: 'smith' })).toEqual(['alice', 'bob']);
    expect(handles(accounts, { search: 'CAR' })).toEqual(['carol']);
  });

  test('the "doesn\'t follow back" filter keeps only accounts known not to follow back', () => {
    const accounts = [
      account('yes', { followsBack: true }),
      account('unknown', { followsBack: null }),
      account('no', { followsBack: false }),
    ];
    expect(handles(accounts, { notFollowingBack: true })).toEqual(['no']);
  });

  test('sort, search and filter combine', () => {
    const accounts = [
      account('dev_ann', { followsBack: false, followersCount: 10 }),
      account('dev_ben', { followsBack: false, followersCount: 99 }),
      account('dev_cat', { followsBack: true, followersCount: 50 }),
      account('ops_dan', { followsBack: false, followersCount: 70 }),
    ];
    expect(
      handles(accounts, { search: 'dev', notFollowingBack: true, sort: { key: 'followers', descending: true } }),
    ).toEqual(['dev_ben', 'dev_ann']);
  });

  test('the inactive-only filter keeps accounts with no post within the threshold, never unknowns', () => {
    const now = day('2026-10-01');
    const accounts = [
      account('recent', { lastPost: ok('2026-09-01') }),
      account('old', { lastPost: ok('2024-01-15') }),
      account('silent', { lastPost: status('no_posts') }),
      account('locked', { lastPost: status('protected') }),
      account('never', { lastPost: null }),
    ];
    expect(handles(accounts, { inactiveOnly: { now } })).toEqual(['old', 'silent']);
    expect(handles(accounts, { inactiveOnly: { now, inactiveAfterMs: 7 * 86_400_000 } })).toEqual([
      'old',
      'recent',
      'silent',
    ]);
  });

  test('the inactive-only filter combines with search, the follow-back filter and sort', () => {
    const now = day('2026-10-01');
    const accounts = [
      account('dev_ann', { followsBack: false, lastPost: ok('2023-03-01') }),
      account('dev_ben', { followsBack: false, lastPost: ok('2022-06-01') }),
      account('dev_cat', { followsBack: true, lastPost: ok('2022-01-01') }),
      account('dev_dot', { followsBack: false, lastPost: ok('2026-09-20') }),
      account('ops_eve', { followsBack: false, lastPost: ok('2021-01-01') }),
    ];
    expect(
      handles(accounts, {
        search: 'dev',
        notFollowingBack: true,
        inactiveOnly: { now },
        sort: { key: 'lastTweet', descending: true },
      }),
    ).toEqual(['dev_ann', 'dev_ben']);
  });
});

describe('cell formatting', () => {
  test('unknown values render as "unknown"', () => {
    expect(formatFollowsBack(null)).toBe('unknown');
    expect(formatLastPost(null)).toBe('unknown');
    expect(formatCount(null)).toBe('unknown');
  });

  test('known values', () => {
    expect(formatFollowsBack(true)).toBe('yes');
    expect(formatFollowsBack(false)).toBe('no');
    expect(formatCount(12345)).toBe('12,345');
    expect(formatCount(0)).toBe('0');
    expect(formatLastPost(ok('2025-03-07'))).toBe('2025-03-07');
    expect(formatLastPost(status('no_posts'))).toBe('no posts');
    expect(formatLastPost(status('protected'))).toBe('protected');
    expect(formatLastPost(status('suspended'))).toBe('suspended');
  });

  test('a never-checked protected or suspended account is labelled from its profile', () => {
    expect(formatLastPost(null, { protected: true, suspended: false })).toBe('protected');
    expect(formatLastPost(null, { protected: false, suspended: true })).toBe('suspended');
    expect(formatLastPost(null, { protected: false, suspended: false })).toBe('unknown');
  });
});
