/** Whole numbers with thousands separators, e.g. `12,345`. */
export const integer = new Intl.NumberFormat('en-US');

/** Local hours and minutes, in the user's locale. */
export const clockTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** `YYYY-MM-DD` (UTC). */
export const formatDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
