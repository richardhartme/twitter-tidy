import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { XClient } from '../auth/index.js';
import type { Cache } from '../cache/index.js';
import { estimateBulkFetch, PRICES } from '../cost/index.js';
import { refreshFollowers, type FollowersSummary } from '../followers/index.js';
import type { FetchProgress } from '../following/index.js';
import { clockTime, integer } from '../format.js';
import { ConfirmPrompt } from './confirm-prompt.js';

export interface FollowersRefreshProps {
  client: XClient;
  cache: Cache;
  userId: string;
  /** Called when the user declines, or dismisses the summary or error. */
  onDone: () => void;
}

type Stage =
  | { name: 'confirm' }
  | { name: 'pulling'; progress: FetchProgress | null; resumeAt: number | null }
  | { name: 'done'; summary: FollowersSummary }
  | { name: 'failed'; message: string };

/** Confirms the cost, pulls the whole followers list into the cache and shows who follows back. */
export function FollowersRefresh({ client, cache, userId, onDone }: FollowersRefreshProps) {
  const [stage, setStage] = useState<Stage>({ name: 'confirm' });
  const [estimate] = useState(() =>
    estimateBulkFetch({
      price: PRICES.followersRead,
      count: cache.followerCount() || null,
      basis: 'based on your last pull',
      unknownCount: 'the total depends on how many accounts follow you',
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
    refreshFollowers({
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
      return <ConfirmPrompt title="Refresh followers" estimate={estimate.text} onConfirm={start} onCancel={onDone} />;
    case 'pulling':
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            Fetching followers…
            {stage.progress && ` page ${stage.progress.pages}, ${integer.format(stage.progress.accounts)} accounts`}
          </Text>
          {stage.resumeAt !== null && <Text color="yellow">Rate limited, resuming at {clockTime(stage.resumeAt)}</Text>}
        </Box>
      );
    case 'done': {
      const { total, followBack, dontFollowBack } = stage.summary;
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text color="green">
            Followers refreshed: {integer.format(total)} followers · {integer.format(followBack)} of the accounts you
            follow follow you back · {integer.format(dontFollowBack)} {dontFollowBack === 1 ? "doesn't" : "don't"}
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
