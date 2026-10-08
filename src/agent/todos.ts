// The task list: what the model last wrote with todo_write, shown as it is. Nothing here infers a status.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

export type ChecklistStatus = 'done' | 'active' | 'open';

/** One row of the list the person sees. */
export interface ChecklistItem {
  title: string;
  status: ChecklistStatus;
}

const SHOWN: Record<TodoStatus, ChecklistStatus> = { completed: 'done', in_progress: 'active', pending: 'open' };
const MARK: Record<TodoStatus, string> = { completed: '[x]', in_progress: '[~]', pending: '[ ]' };

/** The list as the person sees it. */
export function checklistOf(todos: readonly TodoItem[] | null | undefined): ChecklistItem[] {
  return (todos ?? []).map((todo) => ({ title: todo.content, status: SHOWN[todo.status] }));
}

/** The list as the model reads it back: one line per task. */
export function todoLines(todos: readonly TodoItem[] | null | undefined): string[] {
  return (todos ?? []).map((todo) => `${MARK[todo.status]} ${todo.content}`);
}
