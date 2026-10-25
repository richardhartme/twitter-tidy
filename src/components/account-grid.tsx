import { Box, Text } from 'ink';

export interface GridColumn<T> {
  key: string;
  heading: string;
  width: number;
  align: 'left' | 'right';
  cell: (row: T) => string;
  /** A marker drawn after the cell text, if any. */
  tag?: (row: T) => string | null;
}

interface AccountGridProps<T extends { id: string }> {
  columns: GridColumn<T>[];
  rows: T[];
  /** Index of the highlighted row. */
  cursor: number;
  /** Index of the first visible row. */
  top: number;
  /** Visible rows. */
  height: number;
  /** Shown in place of rows when there are none. */
  empty: string;
  /** Whether a row carries the batch mark. */
  isMarked?: (row: T) => boolean;
}

/** Drawn before each row: the batch mark, then the highlight. */
const rowPrefix = (highlighted: boolean, marked = false) => `${marked ? '●' : ' '}${highlighted ? '❯' : ' '} `;

interface CellProps {
  column: Pick<GridColumn<unknown>, 'width' | 'align'>;
  text: string;
  tag?: string | null;
  bold?: boolean;
  highlighted?: boolean;
}

function Cell({ column, text, tag, bold, highlighted }: CellProps) {
  return (
    <Box width={column.width} justifyContent={column.align === 'right' ? 'flex-end' : 'flex-start'} paddingRight={1}>
      <Text bold={bold} color={highlighted ? 'green' : undefined} wrap="truncate">
        {text}
        {tag && <Text color="yellow"> {tag}</Text>}
      </Text>
    </Box>
  );
}

/** A heading line and the visible window of rows, with the highlighted row marked. */
export function AccountGrid<T extends { id: string }>({
  columns,
  rows,
  cursor,
  top,
  height,
  empty,
  isMarked,
}: AccountGridProps<T>) {
  return (
    <>
      <Box>
        <Text>{rowPrefix(false)}</Text>
        {columns.map((c) => (
          <Cell key={c.key} column={c} text={c.heading} bold />
        ))}
      </Box>
      {rows.slice(top, top + height).map((row, i) => {
        const highlighted = top + i === cursor;
        return (
          <Box key={row.id}>
            <Text color="green">{rowPrefix(highlighted, isMarked?.(row))}</Text>
            {columns.map((c) => (
              <Cell key={c.key} column={c} text={c.cell(row)} tag={c.tag?.(row)} highlighted={highlighted} />
            ))}
          </Box>
        );
      })}
      {rows.length === 0 && (
        <Text dimColor>
          {'  '}
          {empty}
        </Text>
      )}
    </>
  );
}
