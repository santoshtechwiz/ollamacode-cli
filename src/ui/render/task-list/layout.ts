import type { ChecklistItem, ChecklistStatus } from '../../../agent/todos';
import { cyan, dim, green } from '../../ansi';
import { todoBox } from '../icons';

/** One row of a drawn task list: a task, or a line standing for several. */
export type TaskRow =
  | { kind: 'task'; status: ChecklistStatus; title: string }
  | { kind: 'summary'; text: string };

/** How each status is drawn; the one place to change or add a look. */
export const TASK_STYLE: Record<ChecklistStatus, { variant?: 'success'; box: Parameters<typeof todoBox>[0]; paint: (s: string) => string; dimTitle?: boolean }> = {
  done: { variant: 'success', box: 'completed', paint: green, dimTitle: true },
  active: { box: 'in_progress', paint: cyan },
  open: { box: 'pending', paint: dim, dimTitle: true },
};

const TITLE_CHARS = 160;
const MAX_ROWS = 24;

function clamp(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The rows to draw. A finished list is one line; a list longer than `maxRows` keeps every task still open and counts
 * the finished ones, so the open work never scrolls away.
 */
export function layoutTaskList(items: readonly ChecklistItem[], { maxRows = MAX_ROWS }: { maxRows?: number } = {}): TaskRow[] {
  const tasks: Extract<TaskRow, { kind: 'task' }>[] = items
    .filter((item) => String(item?.title ?? '').trim())
    .map((item) => ({ kind: 'task', status: item.status, title: clamp(item.title, TITLE_CHARS) }));
  if (tasks.length === 0) return [];
  const open = tasks.filter((row) => row.status !== 'done');
  if (open.length === 0) return [{ kind: 'summary', text: `all ${tasks.length} step${tasks.length === 1 ? '' : 's'} done` }];
  if (tasks.length <= maxRows) return tasks;
  const closed = tasks.length - open.length;
  const keep = open.slice(-(maxRows - 2));
  const cut = open.length - keep.length;
  return [
    ...(closed ? [{ kind: 'summary' as const, text: `${closed} done` }] : []),
    ...(cut ? [{ kind: 'summary' as const, text: `… ${cut} earlier step${cut === 1 ? '' : 's'}` }] : []),
    ...keep,
  ];
}

/** The list as plain lines, for output that is not drawn by Ink (a pipe, the transcript dump). */
export function taskListLines(items: readonly ChecklistItem[], options: { maxRows?: number } = {}): string[] {
  return layoutTaskList(items, options).map((row) => {
    if (row.kind === 'summary') return `  ${dim(row.text)}`;
    const style = TASK_STYLE[row.status];
    return `  ${style.paint(todoBox(style.box))} ${style.dimTitle ? dim(row.title) : row.title}`;
  });
}
