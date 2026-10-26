import { useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';

export type BulkRunStage<Progress, Summary> =
  | { name: 'confirm' }
  | { name: 'running'; progress: Progress | null; resumeAt: number | null; stopping: boolean }
  | { name: 'done'; summary: Summary }
  | { name: 'failed'; message: string };

/** What a bulk screen hands its run: the stop signal and where to report progress and waits. */
export interface BulkRunHooks<Progress> {
  signal: AbortSignal;
  onProgress: (progress: Progress) => void;
  onRateLimit: (resumeAt: number) => void;
}

/**
 * The stages of a confirm-then-run screen. `start` runs the batch; esc or `c` stops it after the
 * account in progress, and any key once it has finished calls `onDone`. The confirm stage's keys are
 * left to its prompt.
 */
export function useBulkRun<Progress, Summary>(onDone: () => void) {
  const [stage, setStage] = useState<BulkRunStage<Progress, Summary>>({ name: 'confirm' });
  const controller = useRef(new AbortController());

  // Ignore results that arrive after the screen has closed.
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  function start(run: (hooks: BulkRunHooks<Progress>) => Promise<Summary>) {
    const update = (patch: Partial<Extract<BulkRunStage<Progress, Summary>, { name: 'running' }>>) =>
      live.current && setStage((s) => (s.name === 'running' ? { ...s, ...patch } : s));
    setStage({ name: 'running', progress: null, resumeAt: null, stopping: false });
    run({
      signal: controller.current.signal,
      onProgress: (progress) => update({ progress, resumeAt: null }),
      onRateLimit: (resumeAt) => update({ resumeAt }),
    }).then(
      (summary) => live.current && setStage({ name: 'done', summary }),
      (err: unknown) =>
        live.current && setStage({ name: 'failed', message: err instanceof Error ? err.message : String(err) }),
    );
  }

  useInput(
    (input, key) => {
      if (stage.name === 'running') {
        // A second press while stopping leaves at once; the call in flight still records its result.
        if (stage.stopping) return onDone();
        if (key.escape || input === 'c') {
          controller.current.abort();
          setStage({ ...stage, stopping: true });
        }
        return;
      }
      onDone();
    },
    { isActive: stage.name !== 'confirm' },
  );

  return { stage, start };
}
