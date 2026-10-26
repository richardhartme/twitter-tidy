import type { Database } from 'better-sqlite3';

/** Ordered schema migrations; migration N (1-based) moves `user_version` from N-1 to N. */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    name TEXT NOT NULL,
    bio TEXT,
    location TEXT,
    created_at TEXT,
    verified INTEGER NOT NULL DEFAULT 0,
    protected INTEGER NOT NULL DEFAULT 0,
    suspended INTEGER NOT NULL DEFAULT 0,
    followers_count INTEGER,
    following_count INTEGER,
    tweet_count INTEGER,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE following (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    first_seen_at INTEGER NOT NULL,
    removed_at INTEGER,
    is_new INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE followers (
    account_id TEXT PRIMARY KEY,
    fetched_at INTEGER NOT NULL
  );
  CREATE TABLE last_post (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    posted_at INTEGER,
    checked_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ok', 'no_posts', 'protected', 'suspended'))
  );
  -- When each full list was last pulled, so an empty pull is distinguishable from none.
  CREATE TABLE sync_state (
    key TEXT PRIMARY KEY,
    synced_at INTEGER NOT NULL
  );
  `,
  // Who removed each account: the app unfollowing it, or a refresh finding it missing.
  `
  ALTER TABLE following ADD COLUMN removed_by TEXT CHECK (removed_by IN ('app', 'refresh'));
  UPDATE following SET removed_by = 'refresh' WHERE removed_at IS NOT NULL;
  `,
];

const userVersion = (db: Database) => db.pragma('user_version', { simple: true }) as number;

/**
 * Applies every migration newer than the database's `user_version`, each in its own write-locked
 * transaction that re-reads the version, so two processes opening the cache at once can't both
 * apply the same migration. Returns the resulting schema version.
 */
export function migrate(db: Database): number {
  const step = db.transaction(() => {
    const v = userVersion(db);
    if (v >= MIGRATIONS.length) return false;
    db.exec(MIGRATIONS[v]!);
    db.pragma(`user_version = ${v + 1}`);
    return true;
  });
  while (step.immediate()) {}
  return userVersion(db);
}
