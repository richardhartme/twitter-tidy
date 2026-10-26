import type { RemovedAccount } from '../cache/index.js';
import { formatDate } from '../format.js';
import { AccountGrid, type GridColumn } from './account-grid.js';

const columns: GridColumn<RemovedAccount>[] = [
  // Flags the accounts the latest refresh removed; the next refresh clears it.
  {
    key: 'handle',
    heading: 'Handle',
    width: 24,
    align: 'left',
    cell: (a) => `@${a.handle}`,
    tag: (a) => (a.recentlyRemoved ? 'removed' : null),
  },
  { key: 'name', heading: 'Name', width: 28, align: 'left', cell: (a) => a.name },
  { key: 'removed', heading: 'Removed ▼', width: 14, align: 'left', cell: (a) => formatDate(a.removedAt) },
  {
    key: 'how',
    heading: 'How',
    width: 12,
    align: 'left',
    cell: (a) => (a.removedBy === 'app' ? 'unfollowed' : 'gone'),
  },
];

/** The keys the removed view answers to. */
export const REMOVED_KEYS = ['↑/↓ PgUp/PgDn move', '/ search', 'o open', 'x back', 'q quit'];

interface RemovedTableProps {
  /** Every removed account, to tell "none removed" from "none match". */
  removed: RemovedAccount[];
  /** The rows shown: searched, most recently removed first. */
  rows: RemovedAccount[];
  cursor: number;
  top: number;
  height: number;
}

/** The removed view (`x`): accounts no longer followed, with when they were removed. */
export function RemovedTable({ removed, rows, cursor, top, height }: RemovedTableProps) {
  return (
    <AccountGrid
      columns={columns}
      rows={rows}
      cursor={cursor}
      top={top}
      height={height}
      empty={removed.length === 0 ? 'No removed accounts.' : 'No accounts match.'}
    />
  );
}
