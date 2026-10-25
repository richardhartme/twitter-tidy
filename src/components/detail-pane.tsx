import { Box, Text } from 'ink';
import type { FollowedAccount } from '../cache/index.js';
import { formatCount, formatFollowsBack, formatLastPost } from '../following/index.js';
import { formatDate } from '../format.js';

const UNKNOWN = 'unknown';
const LABEL_WIDTH = 18;

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

/** `YYYY-MM-DD` (UTC) of an ISO date, or `unknown`. */
function formatJoined(createdAt: string | null): string {
  const time = createdAt === null ? NaN : Date.parse(createdAt);
  return Number.isNaN(time) ? UNKNOWN : formatDate(time);
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text dimColor>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}

/** Everything the cache knows about one followed account. */
export function DetailPane({ account: a }: { account: FollowedAccount }) {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text>
        <Text bold>{a.name}</Text> <Text color="green">@{a.handle}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Field label="Bio" value={a.bio || UNKNOWN} />
        <Field label="Location" value={a.location || UNKNOWN} />
        <Field label="Joined" value={formatJoined(a.createdAt)} />
        <Field label="Verified" value={yesNo(a.verified)} />
        <Field label="Protected" value={yesNo(a.protected)} />
        {a.suspended && <Field label="Suspended" value="yes" />}
        <Field label="Followers" value={formatCount(a.followersCount)} />
        <Field label="Following" value={formatCount(a.followingCount)} />
        <Field label="Posts" value={formatCount(a.tweetCount)} />
        <Field label="Follows you back" value={formatFollowsBack(a.followsBack)} />
        <Field label="Last tweet" value={formatLastPost(a.lastPost, a)} />
      </Box>
    </Box>
  );
}
