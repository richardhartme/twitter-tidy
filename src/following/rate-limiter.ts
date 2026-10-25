import type { XClient } from '../auth/index.js';

/** X's per-user limit on timeline reads: 900 requests per 15 minutes. */
export const TIMELINE_RATE_LIMIT = { limit: 900, windowMs: 15 * 60_000 } as const;

export interface RateLimiterOptions {
  /** Calls allowed in any window (default 900). */
  limit?: number;
  /** The sliding window's length in milliseconds (default 15 minutes). */
  windowMs?: number;
  now?: () => number;
  /** Waits `ms`; should settle early when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface AcquireOptions {
  signal?: AbortSignal;
  /** Called before a wait with the time (epoch milliseconds) the next call can go. */
  onWait?: (resumeAt: number) => void;
}

export interface RateLimiter {
  /** Resolves once one more call fits in the window, and counts it; rejects if `signal` aborts. */
  acquire(options?: AcquireOptions): Promise<void>;
}

const abortableSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });

const aborted = () => new DOMException('The run was aborted', 'AbortError');

/** A sliding-window limiter: never more than `limit` calls in any `windowMs`. */
export function createRateLimiter({
  limit = TIMELINE_RATE_LIMIT.limit,
  windowMs = TIMELINE_RATE_LIMIT.windowMs,
  now = Date.now,
  sleep = abortableSleep,
}: RateLimiterOptions = {}): RateLimiter {
  /** Times of the calls still inside the window, oldest first. */
  const calls: number[] = [];
  return {
    async acquire({ signal, onWait } = {}) {
      for (;;) {
        if (signal?.aborted) throw aborted();
        const t = now();
        while (calls.length > 0 && calls[0]! <= t - windowMs) calls.shift();
        if (calls.length < limit) {
          calls.push(t);
          return;
        }
        const resumeAt = calls[0]! + windowMs;
        onWait?.(resumeAt);
        await sleep(resumeAt - t, signal);
      }
    },
  };
}

/** A client whose every request, retries after a 429 or 401 included, first waits for a slot in `limiter`. */
export function pacedClient(client: XClient, limiter: RateLimiter, options: AcquireOptions = {}): XClient {
  return {
    get tokens() {
      return client.tokens;
    },
    async fetch(path, init, rateLimitOptions) {
      await limiter.acquire(options);
      return client.fetch(path, init, {
        ...rateLimitOptions,
        beforeRetry: async () => {
          await limiter.acquire(options);
          await rateLimitOptions?.beforeRetry?.();
        },
      });
    },
  };
}
