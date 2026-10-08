import { createElement as h } from 'react';
import { Box, Text } from 'ink';
import { Spinner, StatusMessage } from '@inkjs/ui';
import type { ChecklistItem } from '../../../agent/todos';
import { dim } from '../../ansi';
import { todoBox, unicodeAllowed } from '../icons';
import { TASK_STYLE, layoutTaskList, type TaskRow } from './layout';

function Row({ row, live }: { row: TaskRow; live: boolean }) {
  if (row.kind === 'summary') return h(Text, null, dim(row.text));
  const style = TASK_STYLE[row.status];
  const title = style.dimTitle ? dim(row.title) : row.title;
  return row.status === 'active' && live
      ? h(Spinner, { label: row.title, type: unicodeAllowed() ? 'dots' : 'line' })
      : style.variant
        ? h(StatusMessage, { variant: style.variant, children: title })
        : h(Text, null, `${style.paint(todoBox(style.box))} ${title}`);
}

/** The task list, drawn: a spinner on the task under way while `live`, a mark and colour per status. */
export function TaskList({ items, live = false, maxRows }: { items: readonly ChecklistItem[]; live?: boolean; maxRows?: number }) {
  const rows = layoutTaskList(items, { maxRows });
  if (rows.length === 0) return null;
  return h(Box, { flexDirection: 'column', paddingLeft: 2 }, ...rows.map((row, i) => h(Row, { key: i, row, live })));
}
