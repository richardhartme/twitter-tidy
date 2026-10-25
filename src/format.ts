/** Whole numbers with thousands separators, e.g. `12,345`. */
export const integer = new Intl.NumberFormat('en-US');

/** `YYYY-MM-DD` (UTC). */
export const formatDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
