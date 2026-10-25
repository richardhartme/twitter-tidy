import { describe, expect, test } from 'vitest';
import { DEFAULT_INACTIVITY_MS, type LastPost } from '../../src/cache/index.js';
import { isInactive } from '../../src/following/index.js';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const THRESHOLD = DEFAULT_INACTIVITY_MS;
const checkedAt = NOW - 1000;
const postedAt = (ms: number | null): LastPost => ({ status: 'ok', postedAt: ms, checkedAt });
const status = (s: 'no_posts' | 'protected' | 'suspended'): LastPost => ({ status: s, postedAt: null, checkedAt });
const inactive = (lastPost: LastPost | null, inactiveAfterMs = THRESHOLD) =>
  isInactive(lastPost, { inactiveAfterMs, now: NOW });

describe('isInactive', () => {
  test('a post exactly at the threshold is still active', () => {
    expect(inactive(postedAt(NOW - THRESHOLD))).toBe(false);
  });

  test('a post one millisecond older than the threshold is inactive', () => {
    expect(inactive(postedAt(NOW - THRESHOLD - 1))).toBe(true);
  });

  test('a recent post is active', () => {
    expect(inactive(postedAt(NOW - 86_400_000))).toBe(false);
  });

  test('uses the given threshold', () => {
    const month = 30 * 86_400_000;
    expect(inactive(postedAt(NOW - 2 * month), month)).toBe(true);
    expect(inactive(postedAt(NOW - 2 * month), 3 * month)).toBe(false);
  });

  test('never-checked and unknown accounts are never inactive', () => {
    expect(inactive(null)).toBe(false);
    expect(inactive(postedAt(null))).toBe(false);
    expect(inactive(status('protected'))).toBe(false);
    expect(inactive(status('suspended'))).toBe(false);
  });

  test('an account with no posts at all is inactive', () => {
    expect(inactive(status('no_posts'))).toBe(true);
  });

  test('defaults to 12 months and the current time', () => {
    expect(isInactive(postedAt(Date.now() - THRESHOLD - 60_000))).toBe(true);
    expect(isInactive(postedAt(Date.now() - THRESHOLD + 60_000))).toBe(false);
  });
});
