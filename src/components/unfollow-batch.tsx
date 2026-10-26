import { Box, Text } from 'ink';
import type { XClient } from '../auth/index.js';
import type { AccountProfile, Cache } from '../cache/index.js';
import type { RateLimiter } from '../following/index.js';
import { accountsText, clockTime, integer } from '../format.js';
import { unfollowAccounts, type BulkUnfollowProgress, type BulkUnfollowSummary } from '../unfollow/index.js';
import { UnfollowPrompt } from './unfollow-prompt.js';
import { useBulkRun } from './use-bulk-run.js';

interface UnfollowBatchProps {
  client: XClient;
  cache: Cache;
  /** The logged-in user's X id. */
  userId: string;
  /** The marked accounts. */
  accounts: AccountProfile[];
  /** How many of them the table's search or filters hid. */
  hidden: number;
  /** The app's unfollow limiter, shared with `u`. */
  limiter: RateLimiter;
  onDone: () => void;
}

function summaryText({ done, total, cancelled, error }: BulkUnfollowSummary) {
  if (error) return `Unfollowed ${integer.format(done)} of ${accountsText(total)}, then stopped: ${error.message}`;
  if (cancelled) return `Stopped after ${integer.format(done)} of ${accountsText(total)}`;
  return `Unfollowed ${accountsText(total)}`;
}

/**
 * Confirms, then unfollows each marked account, paced under X's unfollow limit. Esc or `c` stops the
 * run; each unfollow is recorded as it succeeds, so the accounts left stay marked and `U` resumes.
 */
export function UnfollowBatch({ client, cache, userId, accounts, hidden, limiter, onDone }: UnfollowBatchProps) {
  const { stage, start } = useBulkRun<BulkUnfollowProgress, BulkUnfollowSummary>(onDone);
  const startUnfollowing = () =>
    start((hooks) => unfollowAccounts({ client, cache, userId, accounts, limiter, ...hooks }));

  const stillMarkedHint = 'The rest are still marked; press U to carry on.';
  switch (stage.name) {
    case 'confirm':
      return <UnfollowPrompt accounts={accounts} hidden={hidden} onConfirm={startUnfollowing} onCancel={onDone} />;
    case 'running': {
      const done = stage.progress?.done ?? 0;
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            Unfollowing… {integer.format(done)} of {accountsText(accounts.length)}
          </Text>
          {stage.resumeAt !== null && (
            <Text color="yellow">Pacing under X&apos;s unfollow limit, resuming at {clockTime(stage.resumeAt)}</Text>
          )}
          <Text dimColor>
            {stage.stopping
              ? 'Stopping after the current account… (any key to leave now)'
              : 'esc / c to stop; the rest stay marked'}
          </Text>
        </Box>
      );
    }
    case 'done': {
      const { summary } = stage;
      const short = summary.done < summary.total;
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={summary.error ? 'red' : short ? 'yellow' : 'green'}>{summaryText(summary)}</Text>
          {short && <Text>{stillMarkedHint}</Text>}
          <Text dimColor>Press any key to return</Text>
        </Box>
      );
    }
    case 'failed':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red">Unfollowing stopped: {stage.message}</Text>
          <Text>{stillMarkedHint}</Text>
          <Text dimColor>Press any key to return</Text>
        </Box>
      );
  }
}
