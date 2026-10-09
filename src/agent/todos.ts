// The task list: outcomes the work must reach, kept in one place (the session state) and changed only through
// todo_write. A task is named by its outcome, which is how the model refers to it. A task is completed on evidence: the
// command that proves it passed with no file changed since, or, for a task no command can prove, what showed it works.
// Nothing here infers a status from what the model wrote.

export type TodoStatus = 'pending' | 'in_progress' | 'completed';
export const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed'];

export interface TodoItem {
  /** The outcome: what will work when this task is done. Also its name. */
  content: string;
  status: TodoStatus;
  /** What must be true for it to count as done. */
  doneWhen?: string;
  /** A command whose pass proves it ("npm test", "dotnet build"). */
  verify?: string;
  /** Tasks (by outcome) that must be completed before this one starts. */
  dependsOn?: string[];
  /** For a task with no verify command: what showed it works. */
  evidence?: string;
  /** Why a completed task was opened again: its verify command failed since. */
  reopened?: string;
}

/** A change to one task, named by its outcome; a name not in the list adds a task. */
export interface TodoUpdate extends Partial<Omit<TodoItem, 'content' | 'reopened'>> {
  task: string;
  /** New wording for the outcome. */
  content?: string;
  remove?: boolean;
  /** Place it after this task (by outcome); a new task without it goes last. */
  after?: string;
}

/** What the session can say about a command: whether it passed with no file changed since. */
export type PassedNow = (command: string) => boolean;

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

/**
 * The list as the model reads it back: one line per task, with what it needs to be done and, for a completed task
 * whose command no longer holds for the files as they are, that it changed since it was checked.
 */
export function todoLines(todos: readonly TodoItem[] | null | undefined, passed?: PassedNow): string[] {
  return (todos ?? []).map((todo) => {
    const notes = [
      todo.dependsOn?.length ? `after: ${todo.dependsOn.join('; ')}` : '',
      todo.doneWhen ? `done when: ${todo.doneWhen}` : '',
      todo.verify ? `verify: \`${todo.verify}\`` : '',
      todo.status === 'completed' && todo.verify && passed && !passed(todo.verify) ? 'changed since it was checked' : '',
      todo.reopened ? `reopened: ${todo.reopened}` : '',
    ].filter(Boolean);
    return `${MARK[todo.status]} ${todo.content}${notes.length ? ` — ${notes.join(' · ')}` : ''}`;
  });
}

const clean = (text: unknown) => String(text ?? '').trim();
const cleanList = (list: unknown) => (Array.isArray(list) ? list.map(clean).filter(Boolean) : undefined);

/** A task as sent, with only the fields it carries. */
export function todoFrom(raw: any): TodoItem {
  const todo: TodoItem = { content: clean(raw?.content), status: raw?.status };
  for (const key of ['doneWhen', 'verify', 'evidence'] as const) if (clean(raw?.[key])) todo[key] = clean(raw[key]);
  const deps = cleanList(raw?.dependsOn);
  if (deps?.length) todo.dependsOn = deps;
  return todo;
}

/** The list after these changes, or what is wrong with them. Tasks no change names stay exactly as they were. */
export function applyUpdates(list: readonly TodoItem[], updates: readonly any[]): TodoItem[] | string {
  // Tasks are never changed in place: an untouched task stays the same object.
  let next = [...list];
  for (const raw of updates) {
    const name = clean(raw?.task);
    if (!name) return 'Each update needs task: the outcome of the task it changes, or of a new one';
    const at = next.findIndex((todo) => todo.content === name);
    if (raw?.remove === true) {
      if (at < 0) return `No task "${name}" to remove. The tasks are: ${next.map((t) => `"${t.content}"`).join(', ') || 'none'}`;
      next.splice(at, 1);
      continue;
    }
    const given = todoFrom({ ...raw, content: raw?.content ?? name, status: raw?.status ?? next[at]?.status ?? 'pending' });
    const todo: TodoItem = at >= 0 ? { ...next[at], ...given } : given;
    // A new status, or new work on it, settles why it was opened again.
    if (raw?.status) delete todo.reopened;
    if (at >= 0) next.splice(at, 1);
    // Renamed: the tasks that wait for it follow the new name.
    if (todo.content !== name) {
      next = next.map((t) => (t.dependsOn?.includes(name) ? { ...t, dependsOn: t.dependsOn.map((d) => (d === name ? todo.content : d)) } : t));
    }
    const after = clean(raw?.after);
    if (after) {
      const anchor = next.findIndex((t) => t.content === after);
      if (anchor < 0) return `No task "${after}" to place "${name}" after`;
      next.splice(anchor + 1, 0, todo);
    } else {
      next.splice(at >= 0 ? at : next.length, 0, todo);
    }
  }
  return next;
}

/**
 * What is wrong with a list the model wants to keep, or null. A task newly completed needs its evidence: its verify
 * command passed with no file changed since, or, with no command, a line saying what showed it works. A task starts
 * or finishes only after the tasks it depends on are completed.
 */
export function checkTodos(next: readonly TodoItem[], before: readonly TodoItem[], passed: PassedNow): string | null {
  if (next.some((todo) => !todo.content)) return 'Each task needs non-empty content';
  if (!next.every((todo) => (TODO_STATUSES as readonly string[]).includes(todo.status))) return `Each status is one of ${TODO_STATUSES.join(', ')}`;
  const names = new Set<string>();
  for (const todo of next) {
    if (names.has(todo.content)) return `Two tasks are both "${todo.content}": each outcome is listed once`;
    names.add(todo.content);
  }
  if (next.filter((todo) => todo.status === 'in_progress').length > 1) return 'More than one task is in_progress — keep one at a time';
  const status = new Map(next.map((todo) => [todo.content, todo.status]));
  const wasDone = new Set(before.filter((todo) => todo.status === 'completed').map((todo) => todo.content));
  for (const todo of next) {
    for (const dep of todo.dependsOn ?? []) {
      if (!status.has(dep)) return `"${todo.content}" depends on "${dep}", which is not in the list`;
      if (todo.status !== 'pending' && status.get(dep) !== 'completed') return `"${todo.content}" cannot start before "${dep}" is completed`;
    }
    if (todo.status !== 'completed' || wasDone.has(todo.content)) continue;
    if (todo.verify && !passed(todo.verify)) {
      return `"${todo.content}" is not completed: \`${todo.verify}\` has not passed on the files as they are now. Run it; once it passes, mark the task completed.`;
    }
    if (!todo.verify && !todo.evidence) {
      return `"${todo.content}" is not completed: give its evidence (what showed it works), or a verify command that proves it.`;
    }
  }
  return null;
}

/** A command failed: the completed tasks it proves are open again, saying why. */
export function reopenFailed(todos: readonly TodoItem[], command: string): TodoItem[] | null {
  const failed = command.trim();
  if (!todos.some((todo) => todo.status === 'completed' && todo.verify === failed)) return null;
  return todos.map((todo) => (todo.status === 'completed' && todo.verify === failed
    ? { ...todo, status: 'pending' as const, reopened: `\`${failed}\` failed after it was completed` }
    : todo));
}
