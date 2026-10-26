import { Box, useApp, useInput, useStdout } from 'ink';
import { useState } from 'react';
import type { XClient } from './auth/index.js';
import { openInBrowser, profileUrl } from './browser.js';
import type { AccountProfile, Cache } from './cache/index.js';
import { FollowersRefresh } from './components/followers-refresh.js';
import { FollowingRefresh } from './components/following-refresh.js';
import { FollowingTable, TABLE_CHROME } from './components/following-table.js';
import { Header } from './components/header.js';
import { LastPostBulkFetch } from './components/last-post-bulk-fetch.js';
import { UnfollowBatch } from './components/unfollow-batch.js';
import { createRateLimiter, fetchLastPostMessage, type RateLimiter } from './following/index.js';
import { UNFOLLOW_RATE_LIMIT, unfollowMessage } from './unfollow/index.js';

/** Lines around the table: the app's padding, plus the header and its margin. */
const APP_CHROME = 2 + 4;
const FALLBACK_ROWS = 24;

type Screen = 'table' | 'refresh-following' | 'refresh-followers' | 'fetch-last-posts' | 'unfollow-marked';

/** The accounts a bulk last-tweet fetch (`a` or `b`) covers, and its prompt's title. */
interface Batch {
  title: string;
  accounts: AccountProfile[];
}

interface AppProps {
  client: XClient;
  cache: Cache;
  /** The logged-in user's X id. */
  userId: string;
  /** Visible table rows; defaults to what fits the terminal. */
  height?: number;
  /** No post within this long counts as inactive (from the config file). Defaults to 12 months. */
  inactiveAfterMs?: number;
  /**
   * Paces every timeline read (`l`, `a`, `b`) under one window, so reruns and single fetches together
   * stay under X's limit. Defaults to one at 900 per 15 minutes for the app's lifetime.
   */
  limiter?: RateLimiter;
  /** Paces every unfollow (`u`, `U`) at X's 50 per 15 minutes, separately from the timeline reads. */
  unfollowLimiter?: RateLimiter;
  /** Opens a URL in the system browser; injectable for tests. */
  openUrl?: (url: string) => void;
}

export function App({
  client,
  cache,
  userId,
  height,
  inactiveAfterMs,
  limiter: injected,
  unfollowLimiter: injectedUnfollow,
  openUrl = openInBrowser,
}: AppProps) {
  const [limiter] = useState(() => injected ?? createRateLimiter());
  const [unfollowLimiter] = useState(() => injectedUnfollow ?? createRateLimiter(UNFOLLOW_RATE_LIMIT));
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [screen, setScreen] = useState<Screen>('table');
  const [accounts, setAccounts] = useState(() => cache.listFollowing());
  const [removed, setRemoved] = useState(() => cache.listRemoved());
  const [hasFollowers, setHasFollowers] = useState(() => cache.hasFollowers());
  const [batch, setBatch] = useState<Batch>({ title: '', accounts: [] });
  const fetchBatch = (next: Batch) => {
    setBatch(next);
    setScreen('fetch-last-posts');
  };
  /** Ids of the rows marked with space, kept here so they outlast the batch screens. */
  const [marks, setMarks] = useState<ReadonlySet<string>>(new Set());
  /** The marked accounts a `U` run covers, and how many of them the table was hiding. */
  const [unfollowBatch, setUnfollowBatch] = useState({ accounts: [] as AccountProfile[], hidden: 0 });

  /** Re-reads the table after anything that may have changed the cache. */
  const reload = () => {
    const following = cache.listFollowing();
    setAccounts(following);
    // Marks on accounts no longer followed (unfollowed, or gone in a refresh) are dropped.
    const followed = new Set(following.map((a) => a.id));
    setMarks((m) => new Set([...m].filter((id) => followed.has(id))));
    setRemoved(cache.listRemoved());
    setHasFollowers(cache.hasFollowers());
  };

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
  });

  // Ink types stdout as a plain stream; a TTY also carries its size.
  const terminalRows = (stdout as Partial<NodeJS.WriteStream>).rows || FALLBACK_ROWS;
  const rows = height ?? Math.max(1, terminalRows - APP_CHROME - TABLE_CHROME);

  const backToTable = () => {
    reload();
    setScreen('table');
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Header title="TwitterTidy" />
      {screen === 'refresh-following' ? (
        <FollowingRefresh client={client} cache={cache} userId={userId} onDone={backToTable} />
      ) : screen === 'refresh-followers' ? (
        <FollowersRefresh client={client} cache={cache} userId={userId} onDone={backToTable} />
      ) : screen === 'fetch-last-posts' ? (
        <LastPostBulkFetch
          client={client}
          cache={cache}
          {...batch}
          inactiveAfterMs={inactiveAfterMs}
          limiter={limiter}
          onDone={backToTable}
        />
      ) : screen === 'unfollow-marked' ? (
        <UnfollowBatch
          client={client}
          cache={cache}
          userId={userId}
          {...unfollowBatch}
          limiter={unfollowLimiter}
          onDone={backToTable}
        />
      ) : (
        <FollowingTable
          accounts={accounts}
          removed={removed}
          hasFollowers={hasFollowers}
          height={rows}
          inactiveAfterMs={inactiveAfterMs}
          onQuit={exit}
          onRefresh={() => setScreen('refresh-following')}
          onRefreshFollowers={() => setScreen('refresh-followers')}
          onFetchLastPost={async (account) => {
            const message = await fetchLastPostMessage({ client, limiter, cache, account, inactiveAfterMs });
            reload();
            return message;
          }}
          onUnfollow={async (account) => {
            const message = await unfollowMessage({ client, cache, userId, account, limiter: unfollowLimiter });
            reload();
            return message;
          }}
          onOpenProfile={(account) => openUrl(profileUrl(account.handle))}
          onFetchStale={() =>
            fetchBatch({
              title: 'Fetch last tweets for all stale accounts',
              accounts: cache.staleAccounts({ inactiveAfterMs }),
            })
          }
          marks={marks}
          onMarksChange={setMarks}
          onUnfollowMarked={(marked, hidden) => {
            setUnfollowBatch({ accounts: marked, hidden });
            setScreen('unfollow-marked');
          }}
          onFetchMarked={(marked) =>
            fetchBatch({
              title: `Fetch last tweets for ${marked.length} marked ${marked.length === 1 ? 'account' : 'accounts'}`,
              accounts: marked,
            })
          }
        />
      )}
    </Box>
  );
}
