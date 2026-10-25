import { describe, expect, test } from 'vitest';
import { estimateBulkFetch, PRICES } from '../src/cost/index.js';

describe('estimateBulkFetch', () => {
  test('with a known count it gives a total', () => {
    expect(estimateBulkFetch({ price: PRICES.followingRead, count: 840, basis: 'based on your last pull' })).toEqual({
      totalUsd: 8.4,
      text: 'About $8.40 for ~840 accounts (based on your last pull)',
    });
    expect(estimateBulkFetch({ price: PRICES.followingRead, count: 2340 }).text).toBe('About $23.40 for ~2,340 accounts');
    expect(estimateBulkFetch({ price: PRICES.followingRead, count: 1 }).text).toBe('About $0.01 for ~1 account');
  });

  test('without a count it gives only the rate', () => {
    expect(
      estimateBulkFetch({ price: PRICES.followingRead, unknownCount: 'the total depends on how many accounts you follow' }),
    ).toEqual({
      totalUsd: null,
      text: '$0.01 per account ($10.00 per 1,000); the total depends on how many accounts you follow',
    });
  });

  test('works for sub-cent prices', () => {
    expect(estimateBulkFetch({ price: 5 * PRICES.postRead }).text).toBe(
      '$0.025 per account ($25.00 per 1,000); the total depends on how many there are',
    );
    expect(estimateBulkFetch({ price: 5 * PRICES.postRead, count: 3 })).toEqual({
      totalUsd: 0.08,
      text: 'About $0.08 for ~3 accounts',
    });
  });
});
