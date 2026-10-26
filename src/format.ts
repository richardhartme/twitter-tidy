/** Whole numbers with thousands separators, e.g. `12,345`. */
export const integer = new Intl.NumberFormat('en-US');

/** A count of accounts, e.g. `1 account`, `12,345 accounts`. */
export const accountsText = (n: number) => `${integer.format(n)} ${n === 1 ? 'account' : 'accounts'}`;

/** Local hours and minutes, in the user's locale. */
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** `YYYY-MM-DD` (UTC). */
export const formatDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
