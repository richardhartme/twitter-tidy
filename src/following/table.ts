import type { AccountProfile, FollowedAccount, InactivityOptions, LastPost, RemovedAccount } from '../cache/index.js';
import { formatDate, integer } from '../format.js';
import { isInactive } from './inactive.js';

export type SortKey = 'handle' | 'followsBack' | 'lastTweet' | 'followers' | 'following';

export interface Sort {
  key: SortKey;
  descending: boolean;
}

export interface ViewOptions {
  sort: Sort;
  /** Case-insensitive substring of the handle or name; empty matches everything. */
  search: string;
  /** Keep only accounts known not to follow back. */
  notFollowingBack: boolean;
  /** Keep only inactive accounts, by these rules; omit to keep every account. */
  inactiveOnly?: InactivityOptions & { now?: number };
}

/** The value an account sorts by, or null when unknown (unknowns always sort last). */
const sortValue: Record<Exclude<SortKey, 'handle'>, (a: FollowedAccount) => number | null> = {
  // "Doesn't follow back" first when ascending: those are the accounts an audit is after.
  followsBack: (a) => (a.followsBack === null ? null : +a.followsBack),
  lastTweet: (a) => (a.lastPost?.status === 'ok' ? a.lastPost.postedAt : null),
  followers: (a) => a.followersCount,
  following: (a) => a.followingCount,
};

const byHandle = (a: FollowedAccount, b: FollowedAccount) =>
  a.handle.localeCompare(b.handle, 'en', { sensitivity: 'base' });

function compare({ key, descending }: Sort): (a: FollowedAccount, b: FollowedAccount) => number {
  const sign = descending ? -1 : 1;
  if (key === 'handle') return (a, b) => sign * byHandle(a, b);
  const value = sortValue[key];
  return (a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) return x === y ? byHandle(a, b) : x === null ? 1 : -1;
    return x === y ? byHandle(a, b) : sign * (x - y);
  };
}

/** Case-insensitive match on handle or name; an empty search matches everything. */
function matches(search: string): (a: AccountProfile) => boolean {
  const needle = search.toLowerCase();
  return (a) => !needle || a.handle.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle);
}

/** The accounts the table shows: filtered, searched and sorted. */
export function viewRows(
  accounts: FollowedAccount[],
  { sort, search, notFollowingBack, inactiveOnly }: ViewOptions,
): FollowedAccount[] {
  return accounts
    .filter((a) => !notFollowingBack || a.followsBack === false)
    .filter((a) => !inactiveOnly || isInactive(a.lastPost, inactiveOnly))
    .filter(matches(search))
    .sort(compare(sort));
}

/** The removed view: accounts no longer followed, searched, most recently removed first. */
export function removedRows(removed: RemovedAccount[], search: string): RemovedAccount[] {
  return removed.filter(matches(search)).sort((a, b) => b.removedAt - a.removedAt);
}

const UNKNOWN = 'unknown';

export const formatFollowsBack = (followsBack: boolean | null) =>
  followsBack === null ? UNKNOWN : followsBack ? 'yes' : 'no';

export const formatCount = (count: number | null) => (count === null ? UNKNOWN : integer.format(count));

/**
 * `YYYY-MM-DD` (UTC) for a known post date, otherwise the status. A protected or suspended
 * account is never checked, so its profile supplies the label until it has been.
 */
export function formatLastPost(
  lastPost: LastPost | null,
  profile?: Pick<FollowedAccount, 'protected' | 'suspended'>,
): string {
  if (lastPost === null) return profile?.suspended ? 'suspended' : profile?.protected ? 'protected' : UNKNOWN;
  switch (lastPost.status) {
    case 'ok':
      return lastPost.postedAt === null ? UNKNOWN : formatDate(lastPost.postedAt);
    case 'no_posts':
      return 'no posts';
    case 'protected':
    case 'suspended':
      return lastPost.status;
  }
}
