import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { XClient } from '../auth/index.js';
import type { Cache } from '../cache/index.js';
import { estimateBulkFetch, PRICES } from '../cost/index.js';
import { refreshFollowing, type FetchProgress, type RefreshSummary } from '../following/index.js';
import { clockTime, integer } from '../format.js';
import { ConfirmPrompt } from './confirm-prompt.js';

interface FollowingRefreshProps {
  client: XClient;
  cache: Cache;
  userId: string;
  onDone: () => void;
}

type Stage =
  | { name: 'confirm' }
  | { name: 'pulling'; progress: FetchProgress | null; resumeAt: number | null }
  | { name: 'done'; summary: RefreshSummary }
  | { name: 'failed'; message: string };

/** Confirms the cost, pulls the whole Following list into the cache and shows what changed. */
export function FollowingRefresh({ client, cache, userId, onDone }: FollowingRefreshProps) {
  const [stage, setStage] = useState<Stage>({ name: 'confirm' });
  const [estimate] = useState(() =>
    estimateBulkFetch({
      // Each account also brings its most recent post, assumed billed as one post read.
      price: PRICES.followingRead + PRICES.postRead,
      count: cache.listFollowing().length || null,
      basis: 'based on your last pull',
      unknownCount: 'the total depends on how many accounts you follow',
    }),
  );

  // Ignore results that arrive after the screen has closed.
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  function start() {
    const update = (patch: Partial<Extract<Stage, { name: 'pulling' }>>) =>
      live.current && setStage((s) => (s.name === 'pulling' ? { ...s, ...patch } : s));
    setStage({ name: 'pulling', progress: null, resumeAt: null });
    refreshFollowing({
      client,
      cache,
      userId,
      onProgress: (progress) => update({ progress, resumeAt: null }),
      onRateLimit: (resumeAt) => update({ resumeAt }),
    }).then(
      (summary) => live.current && setStage({ name: 'done', summary }),
      (err: unknown) =>
        live.current && setStage({ name: 'failed', message: err instanceof Error ? err.message : String(err) }),
    );
  }

  useInput(() => {
    if (stage.name === 'done' || stage.name === 'failed') onDone();
  });

  switch (stage.name) {
    case 'confirm':
      return (
        <ConfirmPrompt
          title="Refresh Following"
          estimate={estimate.text}
          onConfirm={start}
          onCancel={onDone}
        />
      );
    case 'pulling':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            Fetching Following…
            {stage.progress && ` page ${stage.progress.pages}, ${integer.format(stage.progress.accounts)} accounts`}
          </Text>
          {stage.resumeAt !== null && <Text color="yellow">Rate limited, resuming at {clockTime(stage.resumeAt)}</Text>}
        </Box>
      );
    case 'done': {
      const { total, added, removed, restored, lastPosts } = stage.summary;
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="green">
            Following refreshed: {integer.format(total)} accounts followed · {added.length} new · {removed.length} removed ·{' '}
            {restored.length} restored · {integer.format(lastPosts)} last tweets dated
          </Text>
          <Text dimColor>Press any key to return</Text>
        </Box>
      );
    }
    case 'failed':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="red">Refresh failed; nothing was changed. {stage.message}</Text>
          <Text dimColor>Press any key to return</Text>
        </Box>
      );
  }
}
