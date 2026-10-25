import { Box, Text, useInput } from 'ink';
import { useMemo, useState, type ReactElement } from 'react';
import type { AccountProfile, FollowedAccount, RemovedAccount } from '../cache/index.js';
import {
  formatCount,
  formatFollowsBack,
  formatLastPost,
  isInactive,
  removedRows,
  viewRows,
  type Sort,
  type SortKey,
} from '../following/index.js';
import { integer } from '../format.js';
import { AccountGrid, type GridColumn } from './account-grid.js';
import { DetailPane } from './detail-pane.js';
import { REMOVED_KEYS, RemovedTable } from './removed-table.js';
import { StatusBar } from './status-bar.js';

interface FollowingTableProps {
  accounts: FollowedAccount[];
  /** Accounts no longer followed, for the removed view. */
  removed: RemovedAccount[];
  /** Whether the followers list has ever been pulled (follow-back is unknown until then). */
  hasFollowers: boolean;
  /** Visible rows. */
  height: number;
  onQuit: () => void;
  onRefresh: () => void;
  onRefreshFollowers: () => void;
  /** Fetches the last tweet for one account (`l`), resolving to a status-bar message. */
  onFetchLastPost: (account: FollowedAccount) => Promise<string>;
  /** Fetches the last tweet for every stale account (`a`). */
  onFetchStale: () => void;
  /** Fetches the last tweet for the rows marked with space (`b`). */
  onFetchMarked: (accounts: FollowedAccount[]) => void;
  /** Opens an account's profile in the system browser (`o`). */
  onOpenProfile: (account: AccountProfile) => void;
  /** No post within this long counts as inactive. Defaults to `DEFAULT_INACTIVITY_MS`. */
  inactiveAfterMs?: number;
  /** The clock inactivity is measured from; injectable for tests. */
  now?: () => number;
}

interface Column extends Omit<GridColumn<FollowedAccount>, 'tag'> {
  key: SortKey;
  /** A marker drawn after the cell text, if any. */
  tag?: (a: FollowedAccount, inactive: boolean) => string | null;
}

/** In sort-key order: key `1` sorts by the first column. */
const columns: Column[] = [
  { key: 'handle', heading: 'Handle', width: 24, align: 'left', cell: (a) => `@${a.handle}`, tag: (a) => (a.isNew ? 'new' : null) },
  { key: 'followsBack', heading: 'Follows back', width: 16, align: 'left', cell: (a) => formatFollowsBack(a.followsBack) },
  {
    key: 'lastTweet',
    heading: 'Last tweet',
    width: 21,
    align: 'left',
    cell: (a) => formatLastPost(a.lastPost, a),
    tag: (_, inactive) => (inactive ? 'inactive' : null),
  },
  { key: 'followers', heading: 'Followers', width: 12, align: 'right', cell: (a) => formatCount(a.followersCount) },
  { key: 'following', heading: 'Following', width: 12, align: 'right', cell: (a) => formatCount(a.followingCount) },
];

/** Lines the table draws besides its rows: heading, search line, status bar and its margin. */
export const TABLE_CHROME = 4;

const TABLE_KEYS = [
  '↑/↓ PgUp/PgDn move',
  '1-5 sort',
  '/ search',
  "f doesn't follow back",
  'i inactive',
  'x removed',
  'enter details',
  'o open',
  'l last tweet',
  'space mark',
  'b/a fetch marked/stale',
  'r refresh',
  'F followers',
  'q quit',
];
const SEARCH_KEYS = ['type to search', 'enter keep', 'esc clear'];
const DETAIL_KEYS = ['o open', 'esc back', 'q quit'];
const NO_FOLLOWERS_HINT = 'Follow-back is unknown until your followers have been pulled';
const NO_MARKS_HINT = 'Mark rows with space, then press b to fetch their last tweets';

/** The main screen: every followed account from the cache, sortable, searchable and filterable. */
export function FollowingTable({
  accounts,
  removed,
  hasFollowers,
  height,
  onQuit,
  onRefresh,
  onRefreshFollowers,
  onFetchLastPost,
  onFetchStale,
  onFetchMarked,
  onOpenProfile,
  inactiveAfterMs,
  now = Date.now,
}: FollowingTableProps) {
  /** Ids of the rows marked for a batch fetch. */
  const [marks, setMarks] = useState<ReadonlySet<string>>(new Set());
  const [sort, setSort] = useState<Sort>({ key: 'handle', descending: false });
  const [search, setSearch] = useState('');
  const [typing, setTyping] = useState(false);
  const [notFollowingBack, setNotFollowingBack] = useState(false);
  const [inactiveOnly, setInactiveOnly] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  /** Whether the detail pane shows the highlighted row; table keys rest while it does. */
  const [detail, setDetail] = useState(false);
  /** A one-off message, cleared by the next key. */
  const [hint, setHint] = useState<string | null>(null);
  // Without a followers pull every follow-back is unknown, so the filter would hide everything.
  const filtering = notFollowingBack && hasFollowers;
  const inactivity = { inactiveAfterMs, now: now() };
  const inactive = (a: FollowedAccount) => isInactive(a.lastPost, inactivity);
  const rows = useMemo(
    () => viewRows(accounts, { sort, search, notFollowingBack: filtering, inactiveOnly: inactiveOnly ? inactivity : undefined }),
    // The clock is read when the rows are computed; a later tick alone doesn't re-filter.
    [accounts, sort, search, filtering, inactiveOnly, inactiveAfterMs],
  );

  const gone = useMemo(() => removedRows(removed, search), [removed, search]);

  // The highlighted row and the first visible row, as indexes into the rows shown.
  const [view, setView] = useState({ cursor: 0, top: 0 });
  const shown = showRemoved ? gone.length : rows.length;
  const last = Math.max(shown - 1, 0);
  const cursor = Math.min(view.cursor, last);
  const top = Math.min(view.top, cursor);

  const moveTo = (target: number) => {
    const next = Math.max(0, Math.min(target, last));
    setView({ cursor: next, top: next < top ? next : next >= top + height ? next - height + 1 : top });
  };

  /** Changes what the table shows, and returns the highlight to the top. */
  const reshape = (apply: () => void) => {
    apply();
    setView({ cursor: 0, top: 0 });
  };

  /** Whether an `l` fetch is in flight (one at a time). */
  const [fetching, setFetching] = useState(false);
  const fetchLastPost = (account: FollowedAccount | undefined) => {
    if (!account || fetching) return;
    setFetching(true);
    setHint(`Fetching @${account.handle}'s last tweet…`);
    void onFetchLastPost(account).then((message) => {
      setFetching(false);
      setHint(message);
    });
  };

  /** The account in the detail pane, if it is open (only from the Following view). */
  const open = detail ? rows[cursor] : undefined;

  const openProfile = (account: AccountProfile | undefined) => {
    if (!account) return;
    onOpenProfile(account);
    setHint(`Opened @${account.handle} in your browser`);
  };

  useInput((input, key) => {
    setHint(null);
    if (open) {
      if (key.escape) setDetail(false);
      else if (input === 'o') openProfile(open);
      else if (input === 'q') onQuit();
      return;
    }
    if (key.upArrow) return moveTo(cursor - 1);
    if (key.downArrow) return moveTo(cursor + 1);
    if (key.pageUp) return moveTo(cursor - height);
    if (key.pageDown) return moveTo(cursor + height);

    if (typing) {
      if (key.return) setTyping(false);
      else if (key.escape) reshape(() => (setSearch(''), setTyping(false)));
      else if (key.backspace || key.delete) reshape(() => setSearch((q) => q.slice(0, -1)));
      else if (input && !key.ctrl && !key.meta) reshape(() => setSearch((q) => q + input));
      return;
    }

    if (input === '/') return setTyping(true);
    if (input === 'q') return onQuit();
    if (input === 'r') return onRefresh();
    if (input === 'F') return onRefreshFollowers();
    if (input === 'x') return reshape(() => setShowRemoved((on) => !on));
    if (input === 'o') return openProfile(showRemoved ? gone[cursor] : rows[cursor]);
    // The rest act on followed accounts only.
    if (showRemoved) return;
    if (key.return) return setDetail(rows.length > 0);
    if (input === 'l') return fetchLastPost(rows[cursor]);
    if (input === ' ') {
      const row = rows[cursor];
      if (!row) return;
      setMarks((m) => {
        const next = new Set(m);
        if (!next.delete(row.id)) next.add(row.id);
        return next;
      });
      return moveTo(cursor + 1);
    }
    if (input === 'b') {
      const marked = accounts.filter((a) => marks.has(a.id));
      if (marked.length === 0) return setHint(NO_MARKS_HINT);
      setMarks(new Set());
      return onFetchMarked(marked);
    }
    if (input === 'a') return onFetchStale();
    if (input === 'i') return reshape(() => setInactiveOnly((on) => !on));
    if (input === 'f') {
      if (!hasFollowers) return setHint(NO_FOLLOWERS_HINT);
      return reshape(() => setNotFollowingBack((on) => !on));
    }
    const column = /^[1-9]$/.test(input) ? columns[Number(input) - 1] : undefined;
    if (column) {
      reshape(() => setSort((s) => ({ key: column.key, descending: s.key === column.key ? !s.descending : false })));
    }
  });

  if (open) {
    return (
      <Box flexDirection="column">
        <DetailPane account={open} />
        <Box marginTop={1}>
          <StatusBar message={`@${open.handle}`} keys={DETAIL_KEYS} />
        </Box>
      </Box>
    );
  }
  const of = (n: number, total: number, noun: string) =>
    n === total ? `${integer.format(n)} ${noun}` : `${integer.format(n)} of ${integer.format(total)} ${noun}`;
  let table: ReactElement;
  let summary: string[];
  let keys: string[];
  if (showRemoved) {
    table = <RemovedTable removed={removed} rows={gone} cursor={cursor} top={top} height={height} />;
    summary = [of(gone.length, removed.length, 'removed accounts')];
    keys = REMOVED_KEYS;
  } else {
    const gridColumns = columns.map(({ tag, ...c }) => ({
      ...c,
      heading: sort.key === c.key ? `${c.heading} ${sort.descending ? '▼' : '▲'}` : c.heading,
      tag: tag && ((a: FollowedAccount) => tag(a, inactive(a))),
    }));
    table = (
      <AccountGrid
        columns={gridColumns}
        rows={rows}
        cursor={cursor}
        top={top}
        height={height}
        empty={accounts.length === 0 ? 'No accounts cached yet. Press r to refresh Following.' : 'No accounts match.'}
        isMarked={(a) => marks.has(a.id)}
      />
    );
    const newCount = accounts.filter((a) => a.isNew).length;
    const markedCount = accounts.filter((a) => marks.has(a.id)).length;
    summary = [
      of(rows.length, accounts.length, 'accounts'),
      ...(newCount ? [`${integer.format(newCount)} new`] : []),
      ...(filtering ? ["Doesn't follow back"] : []),
      ...(markedCount ? [`${integer.format(markedCount)} marked`] : []),
      ...(inactiveOnly ? ['Inactive only'] : []),
    ];
    keys = TABLE_KEYS;
  }
  return (
    <Box flexDirection="column">
      {table}
      <Text color={typing ? 'cyan' : undefined} dimColor={!typing}>
        {typing || search ? `/${search}${typing ? '▏' : ''}` : ' '}
      </Text>
      <Box marginTop={1}>
        <StatusBar message={hint ?? summary.join(' · ')} keys={typing ? SEARCH_KEYS : keys} />
      </Box>
    </Box>
  );
}
