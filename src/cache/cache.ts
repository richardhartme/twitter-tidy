import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { migrate } from './migrations.js';

export interface AccountProfile {
  id: string;
  handle: string;
  name: string;
  bio: string | null;
  location: string | null;
  /** ISO 8601 join date. */
  createdAt: string | null;
  verified: boolean;
  protected: boolean;
  suspended: boolean;
  followersCount: number | null;
  followingCount: number | null;
  tweetCount: number | null;
}

export type LastPostStatus = 'ok' | 'no_posts' | 'protected' | 'suspended';

export interface LastPost {
  status: LastPostStatus;
  /** Epoch milliseconds of the newest post; set only when `status` is `ok`. */
  postedAt: number | null;
  /** Epoch milliseconds. */
  checkedAt: number;
}

/** The outcome of one last-post check; only `ok` carries a post date. */
export type LastPostResult =
  | { status: 'ok'; postedAt: number }
  | { status: Exclude<LastPostStatus, 'ok'> };

export interface FollowedAccount extends AccountProfile {
  isNew: boolean;
  /** Null until the followers list has been pulled. */
  followsBack: boolean | null;
  /** Null until the last post has been checked. */
  lastPost: LastPost | null;
}

/** A profile from a Following pull, with its newest post when the pull carried one. */
export interface PulledAccount extends AccountProfile {
  lastPost: LastPostResult | null;
}

export interface RemovedAccount extends AccountProfile {
  /** Epoch milliseconds. */
  removedAt: number;
  /** Removed by the most recent Following refresh; clears on the next one. */
  recentlyRemoved: boolean;
}

export interface ApplyFollowingResult {
  added: string[];
  removed: string[];
  restored: string[];
}

const DAY_MS = 86_400_000;

/** An account with no post within this window counts as inactive (12 months). */
export const DEFAULT_INACTIVITY_MS = 365 * DAY_MS;
/** Re-check active accounts after this long. */
const ACTIVE_RECHECK_MS = 30 * DAY_MS;
/** Re-check inactive and no-posts accounts after this long. */
const INACTIVE_RECHECK_MS = 90 * DAY_MS;
/** `sync_state` key recording the last followers pull. */
const FOLLOWERS_SYNC = 'followers';
/** `sync_state` key recording the last Following pull. */
const FOLLOWING_SYNC = 'following';

export const defaultCachePath = () => join(homedir(), '.config', 'twittertidy', 'cache.db');

/** The inactivity threshold, shared by the staleness rules and the inactive flag. */
export interface InactivityOptions {
  /** No post within this long counts as inactive. Defaults to `DEFAULT_INACTIVITY_MS` (12 months). */
  inactiveAfterMs?: number;
}

export interface CacheOptions {
  /** Database file, or `:memory:` for tests. Defaults to `defaultCachePath()`. */
  path?: string;
  /** Epoch milliseconds. */
  now?: () => number;
}

interface AccountRow {
  id: string;
  handle: string;
  name: string;
  bio: string | null;
  location: string | null;
  created_at: string | null;
  verified: number;
  protected: number;
  suspended: number;
  followers_count: number | null;
  following_count: number | null;
  tweet_count: number | null;
}

const toProfile = (r: AccountRow): AccountProfile => ({
  id: r.id,
  handle: r.handle,
  name: r.name,
  bio: r.bio,
  location: r.location,
  createdAt: r.created_at,
  verified: r.verified === 1,
  protected: r.protected === 1,
  suspended: r.suspended === 1,
  followersCount: r.followers_count,
  followingCount: r.following_count,
  tweetCount: r.tweet_count,
});

export function openCache({ path = defaultCachePath(), now: clock = Date.now }: CacheOptions = {}) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('foreign_keys = ON');
  const schemaVersion = migrate(db);

  const upsertAccount = db.prepare(`
    INSERT INTO accounts (id, handle, name, bio, location, created_at, verified, protected, suspended,
                          followers_count, following_count, tweet_count, fetched_at)
    VALUES (@id, @handle, @name, @bio, @location, @createdAt, @verified, @protected, @suspended,
            @followersCount, @followingCount, @tweetCount, @fetchedAt)
    ON CONFLICT (id) DO UPDATE SET
      handle = excluded.handle, name = excluded.name, bio = excluded.bio, location = excluded.location,
      created_at = excluded.created_at, verified = excluded.verified, protected = excluded.protected,
      suspended = excluded.suspended, followers_count = excluded.followers_count,
      following_count = excluded.following_count, tweet_count = excluded.tweet_count,
      fetched_at = excluded.fetched_at`);
  const insertFollowing = db.prepare(
    'INSERT INTO following (account_id, first_seen_at, is_new) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  const anyEverFollowed = db.prepare('SELECT EXISTS (SELECT 1 FROM following)').pluck();
  const clearNew = db.prepare('UPDATE following SET is_new = 0 WHERE is_new = 1');
  const selectActiveIds = db.prepare('SELECT account_id FROM following WHERE removed_at IS NULL').pluck();
  const softRemove = db.prepare('UPDATE following SET removed_at = ? WHERE account_id = ?');
  const restore = db.prepare(
    'UPDATE following SET removed_at = NULL WHERE account_id = ? AND removed_at IS NOT NULL',
  );
  const selectFollowing = db.prepare(`
    SELECT a.*, f.is_new,
      lp.status AS last_post_status, lp.posted_at AS last_posted_at, lp.checked_at AS last_checked_at,
      CASE WHEN NOT EXISTS (SELECT 1 FROM sync_state WHERE key = @followersSync) THEN NULL
           ELSE EXISTS (SELECT 1 FROM followers fo WHERE fo.account_id = a.id) END AS follows_back
    FROM following f JOIN accounts a ON a.id = f.account_id
    LEFT JOIN last_post lp ON lp.account_id = a.id
    WHERE f.removed_at IS NULL ORDER BY a.handle COLLATE NOCASE`);
  const upsertLastPost = db.prepare(`
    INSERT INTO last_post (account_id, posted_at, checked_at, status) VALUES (?, ?, ?, ?)
    ON CONFLICT (account_id) DO UPDATE SET
      posted_at = excluded.posted_at, checked_at = excluded.checked_at, status = excluded.status`);
  const clearFollowers = db.prepare('DELETE FROM followers');
  const insertFollower = db.prepare('INSERT OR IGNORE INTO followers (account_id, fetched_at) VALUES (?, ?)');
  const countFollowers = db.prepare('SELECT COUNT(*) FROM followers').pluck();
  const markSynced = db.prepare(
    'INSERT INTO sync_state (key, synced_at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET synced_at = excluded.synced_at',
  );
  const selectSynced = db.prepare('SELECT synced_at FROM sync_state WHERE key = ?').pluck();
  const selectRemoved = db.prepare(`
    SELECT a.*, f.removed_at,
      f.removed_at = (SELECT synced_at FROM sync_state WHERE key = @followingSync) AS recently_removed
    FROM following f JOIN accounts a ON a.id = f.account_id
    WHERE f.removed_at IS NOT NULL ORDER BY f.removed_at DESC, a.handle COLLATE NOCASE`);
  const selectStale = db.prepare(`
    SELECT a.* FROM following f JOIN accounts a ON a.id = f.account_id
    LEFT JOIN last_post lp ON lp.account_id = a.id
    WHERE f.removed_at IS NULL AND a.protected = 0 AND a.suspended = 0
      AND (@accountId IS NULL OR a.id = @accountId) AND (
      lp.account_id IS NULL
      OR (lp.status = 'ok' AND lp.posted_at >= @inactiveBefore AND lp.checked_at < @now - @activeRecheck)
      OR ((lp.status = 'no_posts' OR (lp.status = 'ok' AND (lp.posted_at IS NULL OR lp.posted_at < @inactiveBefore)))
          AND lp.checked_at < @now - @inactiveRecheck)
    )
    ORDER BY a.handle COLLATE NOCASE`);

  const staleParams = (accountId: string | null, inactiveAfterMs: number) => {
    const now = clock();
    return {
      accountId,
      now,
      inactiveBefore: now - inactiveAfterMs,
      activeRecheck: ACTIVE_RECHECK_MS,
      inactiveRecheck: INACTIVE_RECHECK_MS,
    };
  };

  return {
    /** The database's schema version after migrating. */
    schemaVersion,

    /**
     * Applies the complete Following list from one pull. Accounts first seen in it are flagged new,
     * except on the first pull into an empty cache. Any last post a profile carries is recorded as a
     * check made now.
     */
    applyFollowing: db.transaction((profiles: (AccountProfile & Partial<Pick<PulledAccount, 'lastPost'>>)[]): ApplyFollowingResult => {
      const now = clock();
      const added: string[] = [];
      const removed: string[] = [];
      const restored: string[] = [];
      const seen = new Set(profiles.map((p) => p.id));
      // The first pull is the baseline, so nothing in it counts as newly followed.
      const isNew = anyEverFollowed.get() === 1 ? 1 : 0;
      clearNew.run();
      for (const id of selectActiveIds.all() as string[]) {
        if (seen.has(id)) continue;
        softRemove.run(now, id);
        removed.push(id);
      }
      for (const { lastPost, ...p } of profiles) {
        upsertAccount.run({
          ...p,
          verified: +p.verified,
          protected: +p.protected,
          suspended: +p.suspended,
          fetchedAt: now,
        });
        if (insertFollowing.run(p.id, now, isNew).changes === 1) added.push(p.id);
        else if (restore.run(p.id).changes === 1) restored.push(p.id);
        if (lastPost) upsertLastPost.run(p.id, lastPost.status === 'ok' ? lastPost.postedAt : null, now, lastPost.status);
      }
      markSynced.run(FOLLOWING_SYNC, now);
      return { added, removed, restored };
    }),

    /** Accounts currently followed, ordered by handle. */
    listFollowing(): FollowedAccount[] {
      type FollowingRow = AccountRow & {
        is_new: number;
        follows_back: number | null;
        last_post_status: LastPostStatus | null;
        last_posted_at: number | null;
        last_checked_at: number | null;
      };
      const rows = selectFollowing.all({ followersSync: FOLLOWERS_SYNC }) as FollowingRow[];
      return rows.map((r) => ({
        ...toProfile(r),
        isNew: r.is_new === 1,
        followsBack: r.follows_back === null ? null : r.follows_back === 1,
        lastPost:
          r.last_post_status === null
            ? null
            : { status: r.last_post_status, postedAt: r.last_posted_at, checkedAt: r.last_checked_at! },
      }));
    },

    /** Stores the result of checking an account's newest post. */
    recordLastPost(accountId: string, result: LastPostResult): void {
      upsertLastPost.run(accountId, result.status === 'ok' ? result.postedAt : null, clock(), result.status);
    },

    /** Replaces the cached followers with the complete list from one pull. */
    replaceFollowers: db.transaction((ids: string[]) => {
      const now = clock();
      clearFollowers.run();
      for (const id of ids) insertFollower.run(id, now);
      markSynced.run(FOLLOWERS_SYNC, now);
    }),

    /** Whether the followers list has ever been pulled. */
    hasFollowers: (): boolean => selectSynced.get(FOLLOWERS_SYNC) !== undefined,

    /** How many followers the last pull found, or null if the followers list has never been pulled. */
    followerCount: (): number | null =>
      selectSynced.get(FOLLOWERS_SYNC) === undefined ? null : (countFollowers.get() as number),

    /**
     * Followed accounts whose last-post date should be (re)fetched: never checked, active and
     * checked over 30 days ago, or inactive / no posts and checked over 90 days ago. Protected,
     * suspended and removed accounts are never stale.
     */
    staleAccounts({ inactiveAfterMs = DEFAULT_INACTIVITY_MS }: InactivityOptions = {}): AccountProfile[] {
      return (selectStale.all(staleParams(null, inactiveAfterMs)) as AccountRow[]).map(toProfile);
    },

    /** Whether one followed account's last-post date should be (re)fetched, by the `staleAccounts` rules. */
    isStale(accountId: string, { inactiveAfterMs = DEFAULT_INACTIVITY_MS }: InactivityOptions = {}): boolean {
      return selectStale.get(staleParams(accountId, inactiveAfterMs)) !== undefined;
    },

    /** Accounts no longer followed, most recently removed first. */
    listRemoved(): RemovedAccount[] {
      type RemovedRow = AccountRow & { removed_at: number; recently_removed: number | null };
      return (selectRemoved.all({ followingSync: FOLLOWING_SYNC }) as RemovedRow[]).map((r) => ({
        ...toProfile(r),
        removedAt: r.removed_at,
        recentlyRemoved: r.recently_removed === 1,
      }));
    },

    close: () => db.close(),
  };
}

export type Cache = ReturnType<typeof openCache>;
