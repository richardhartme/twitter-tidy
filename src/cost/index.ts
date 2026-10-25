import { integer } from '../format.js';

/**
 * X pay-per-use prices in US dollars. These are the published approximations; confirm the real
 * per-endpoint prices for this account in the X Developer Console.
 */
export const PRICES = {
  /** One account returned by a Following pull. Confirm in the Developer Console. */
  followingRead: 0.01,
  /** One account returned by a followers pull. Confirm in the Developer Console. */
  followersRead: 0.01,
  /** One post returned by a timeline read. Confirm in the Developer Console. */
  postRead: 0.005,
  /** One read of the user's own data (e.g. `/2/users/me`). Confirm in the Developer Console. */
  ownedRead: 0.001,
} as const;

export interface BulkFetchEstimate {
  /** Null when the number of items isn't known yet. */
  totalUsd: number | null;
  text: string;
}

export interface EstimateOptions {
  /** Dollars per account fetched (e.g. 5 posts × the post price for a last-post check). */
  price: number;
  /** How many accounts the fetch is expected to cover, if known. */
  count?: number | null;
  /** Where `count` comes from, shown in brackets (e.g. "based on your last pull"). */
  basis?: string;
  /** Shown after the rate when `count` is unknown. */
  unknownCount?: string;
}

const dollars = (usd: number, maxDigits = 2) =>
  usd.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: maxDigits });

/** Estimates the cost of a bulk fetch over accounts, as a total when the item count is known and as a rate when it isn't. */
export function estimateBulkFetch({
  price,
  count,
  basis,
  unknownCount = 'the total depends on how many there are',
}: EstimateOptions): BulkFetchEstimate {
  // Work in tenths of a cent so sub-cent prices total exactly before rounding to cents.
  const mills = Math.round(price * 1000);
  if (count == null) {
    return {
      totalUsd: null,
      text: `${dollars(mills / 1000, 3)} per account (${dollars(mills)} per 1,000); ${unknownCount}`,
    };
  }
  const totalUsd = Math.round((mills * count) / 10) / 100;
  const items = `~${integer.format(count)} ${count === 1 ? 'account' : 'accounts'}`;
  return { totalUsd, text: `About ${dollars(totalUsd)} for ${items}${basis ? ` (${basis})` : ''}` };
}
