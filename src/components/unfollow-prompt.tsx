import { Box, Text, useInput } from 'ink';
import type { AccountProfile } from '../cache/index.js';
import { estimateBulkFetch, PRICES } from '../cost/index.js';
import { integer } from '../format.js';
import { UNFOLLOW_RATE_LIMIT } from '../unfollow/index.js';

/** Handles listed before "and N more". */
const LISTED = 10;

interface UnfollowPromptProps {
  /** The accounts to unfollow; one for `u`, the marked ones for `U`. */
  accounts: AccountProfile[];
  /** How many of them the current search or filters hide. */
  hidden?: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The length of X's unfollow window, in minutes. */
const windowMinutes = UNFOLLOW_RATE_LIMIT.windowMs / 60_000;

/** Minutes a batch waits at X's unfollow limit: each full window after the first. */
const waitMinutes = (n: number) => (Math.ceil(n / UNFOLLOW_RATE_LIMIT.limit) - 1) * windowMinutes;

/** Asks y/N (No by default) before unfollowing, with what it covers and costs. */
export function UnfollowPrompt({ accounts, hidden = 0, onConfirm, onCancel }: UnfollowPromptProps) {
  // Unlike ConfirmPrompt, enter cancels: unfollowing can't be undone from here, so only `y` goes ahead.
  useInput((input) => (input === 'y' ? onConfirm() : onCancel()));

  const single = accounts.length === 1 ? accounts[0] : undefined;
  const count = integer.format(accounts.length);
  const listed = accounts.slice(0, LISTED).map((a) => `@${a.handle}`);
  const more = accounts.length - listed.length;
  const protectedCount = accounts.filter((a) => a.protected).length;
  const minutes = waitMinutes(accounts.length);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{single ? `Unfollow @${single.handle}?` : `Unfollow ${count} marked accounts?`}</Text>
      {!single && <Text>{`${listed.join(', ')}${more > 0 ? ` and ${integer.format(more)} more` : ''}`}</Text>}
      {hidden > 0 && <Text color="yellow">{integer.format(hidden)} of them are not shown by the current view</Text>}
      {protectedCount > 0 && (
        <Text color="yellow">
          {single ? `@${single.handle} is` : `${integer.format(protectedCount)} ${protectedCount === 1 ? 'is' : 'are'}`}{' '}
          protected: re-following needs their approval
        </Text>
      )}
      {minutes > 0 && (
        <Text>
          Takes about {integer.format(minutes)} minutes at X&apos;s limit of {UNFOLLOW_RATE_LIMIT.limit} per{' '}
          {windowMinutes} minutes
        </Text>
      )}
      <Text>Estimated cost: {estimateBulkFetch({ price: PRICES.unfollow, count: accounts.length }).text} (unconfirmed)</Text>
      <Text dimColor>y to unfollow · any other key to cancel</Text>
    </Box>
  );
}
