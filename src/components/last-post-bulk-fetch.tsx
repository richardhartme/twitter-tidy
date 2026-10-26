import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import type { XClient } from '../auth/index.js';
import type { AccountProfile, Cache } from '../cache/index.js';
import { estimateBulkFetch, PRICES } from '../cost/index.js';
import {
  countLastPostFetches,
  fetchLastPosts,
  POSTS_PER_CHECK,
  type BulkLastPostProgress,
  type BulkLastPostSummary,
  type RateLimiter,
} from '../following/index.js';
import { accountsText, clockTime, integer } from '../format.js';
import { ConfirmPrompt } from './confirm-prompt.js';
import { useBulkRun } from './use-bulk-run.js';

interface LastPostBulkFetchProps {
  client: XClient;
  cache: Cache;
  /** The accounts to check; the ones that are fresh or can't be read are skipped without a call. */
  accounts: AccountProfile[];
  title: string;
  /** No post within this long counts as inactive. Defaults to the cache default. */
  inactiveAfterMs?: number;
  /** Paces the calls; shared across the app so every timeline read counts against one window. */
  limiter: RateLimiter;
  onDone: () => void;
}

const NO_CALLS_ESTIMATE = '$0.00, no API calls needed';

function summaryText({ done, total, fetched, recorded, skipped, failed, cancelled }: BulkLastPostSummary) {
  const parts = [`${integer.format(fetched)} fetched`];
  if (recorded) parts.push(`${integer.format(recorded)} with no posts`);
  if (skipped) parts.push(`${integer.format(skipped)} skipped`);
  if (failed.length) parts.push(`${integer.format(failed.length)} failed`);
  const head = cancelled
    ? `Stopped after ${integer.format(done)} of ${accountsText(total)}; results so far are kept`
    : `Checked ${accountsText(total)}`;
  return `${head}: ${parts.join(' · ')}`;
}

/**
 * Confirms the cost, then checks the last tweet of each account, paced under the rate limit. Esc or
 * `c` stops the run; every result is recorded as it arrives, so running it again resumes.
 */
export function LastPostBulkFetch({
  client,
  cache,
  accounts,
  title,
  inactiveAfterMs,
  limiter,
  onDone,
}: LastPostBulkFetchProps) {
  const [calls] = useState(() => countLastPostFetches(cache, accounts, { inactiveAfterMs }));
  const { stage, start } = useBulkRun<BulkLastPostProgress, BulkLastPostSummary>(onDone);
  const startFetching = () =>
    start((hooks) => fetchLastPosts({ client, cache, accounts, inactiveAfterMs, limiter, ...hooks }));

  // With nothing to fetch there's no prompt, so any key returns.
  useInput(() => onDone(), { isActive: accounts.length === 0 });

  if (accounts.length === 0) {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>Nothing to fetch: every account&apos;s last tweet is up to date.</Text>
        <Text dimColor>Press any key to return</Text>
      </Box>
    );
  }

  switch (stage.name) {
    case 'confirm':
      return (
        <ConfirmPrompt
          title={title}
          estimate={
            // Only accounts with no posts, say: still confirmed, so a run never starts unasked.
            calls === 0
              ? NO_CALLS_ESTIMATE
              : estimateBulkFetch({ price: POSTS_PER_CHECK * PRICES.postRead, count: calls }).text
          }
          onConfirm={startFetching}
          onCancel={onDone}
        />
      );
    case 'running': {
      const done = stage.progress?.done ?? 0;
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            Fetching last tweets… {integer.format(done)} of {accountsText(accounts.length)}
          </Text>
          {stage.resumeAt !== null && (
            <Text color="yellow">Pacing under the rate limit, resuming at {clockTime(stage.resumeAt)}</Text>
          )}
          <Text dimColor>
            {stage.stopping
              ? 'Stopping after the current account… (any key to leave now)'
              : 'esc / c to stop; results so far are kept'}
          </Text>
        </Box>
      );
    }
    case 'done':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={stage.summary.cancelled ? 'yellow' : 'green'}>{summaryText(stage.summary)}</Text>
          {stage.summary.failed.slice(0, 3).map((f) => (
            <Text key={f.handle} color="red">
              @{f.handle}: {f.message}
            </Text>
          ))}
          <Text dimColor>Press any key to return</Text>
        </Box>
      );
    case 'failed':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red">Fetch stopped: {stage.message} Results so far are kept.</Text>
          <Text dimColor>Press any key to return</Text>
        </Box>
      );
  }
}
