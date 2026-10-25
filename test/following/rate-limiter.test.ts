import { describe, expect, test, vi } from 'vitest';
import { createXClient } from '../../src/auth/client.js';
import type { TokenStore } from '../../src/auth/token-store.js';
import { createRateLimiter, pacedClient } from '../../src/following/index.js';

const MINUTE = 60_000;
const WINDOW = 15 * MINUTE;

/** A fake clock whose sleep advances time instantly, recording each wait. */
function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => (t += ms),
    sleeps,
  };
}

/** The most calls made in any window of `windowMs`, given sorted call times. */
function busiestWindow(times: number[], windowMs: number) {
  let most = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (times[end]! - times[start]! >= windowMs) start++;
    most = Math.max(most, end - start + 1);
  }
  return most;
}

describe('createRateLimiter', () => {
  test('lets the first 900 calls through at once, then waits for the window to slide', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 900; i++) await limiter.acquire();
    expect(clock.sleeps).toEqual([]);

    const start = clock.now();
    await limiter.acquire();
    expect(clock.now()).toBe(start + WINDOW);
  });

  test('never allows more than 900 calls in any 15-minute window', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep });
    const times: number[] = [];
    for (let i = 0; i < 3_000; i++) {
      await limiter.acquire();
      times.push(clock.now());
      clock.advance(i % 7 === 0 ? 1_500 : 100); // uneven pacing between calls
    }
    expect(busiestWindow(times, WINDOW)).toBe(900);
  });

  test('reports when it will resume before waiting', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep, limit: 2, windowMs: MINUTE });
    const resumes: number[] = [];
    await limiter.acquire();
    clock.advance(10_000);
    await limiter.acquire();
    await limiter.acquire({ onWait: (resumeAt) => resumes.push(resumeAt) });
    expect(resumes).toEqual([1_000_000 + MINUTE]);
  });

  test('an aborted wait rejects without using a slot', async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    const limiter = createRateLimiter({
      now: clock.now,
      sleep: async () => controller.abort(),
      limit: 1,
      windowMs: MINUTE,
    });
    await limiter.acquire();
    await expect(limiter.acquire({ signal: controller.signal })).rejects.toThrow(/aborted/i);
  });
});

describe('pacedClient', () => {
  test('a retry after a 429 takes its own slot in the window', async () => {
    const clock = fakeClock();
    const limiter = createRateLimiter({ now: clock.now, sleep: clock.sleep, limit: 2, windowMs: MINUTE });
    const responses = [new Response(null, { status: 429 }), new Response('{}'), new Response('{}')];
    const sent: number[] = [];
    const client = createXClient({
      config: { clientId: 'cid', port: 1, redirectUri: 'http://127.0.0.1:1/callback' },
      store: { save: vi.fn() } as unknown as TokenStore,
      tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: 0, userId: '1', handle: 'me' },
      fetch: (async () => {
        sent.push(clock.now());
        return responses.shift()!;
      }) as never,
      now: clock.now,
      sleep: async () => {},
    });
    const paced = pacedClient(client, limiter);

    expect((await paced.fetch('/x')).status).toBe(200);
    expect((await paced.fetch('/y')).status).toBe(200);
    // The 429 and its retry used both slots, so the second call waits for the window.
    expect(sent).toEqual([1_000_000, 1_000_000, 1_000_000 + MINUTE]);
  });
});
