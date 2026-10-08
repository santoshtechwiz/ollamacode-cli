import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../../tool/core/defineTool';
import { ok, fail } from '../../tool/core/tool-result';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** The steps on a task list that still have work left: named and not completed. */
/** The task list, when the task running now wrote it; a list another task left behind is not this task's. */
export function taskTodos(state: { todos?: unknown; todosTask?: unknown; taskId?: unknown } | null | undefined): TodoItem[] {
  // A list no task wrote is no task's, even while no task is running: "none" must not match "none".
  const owned = state?.todosTask !== undefined && state?.todosTask !== null && state.todosTask === state.taskId;
  return owned && Array.isArray(state?.todos) ? (state.todos as TodoItem[]) : [];
}

export function unfinishedTodos(todos: unknown): TodoItem[] {
  if (!Array.isArray(todos)) return [];
  return todos.filter((todo) => todo?.status !== 'completed' && String(todo?.content ?? '').trim());
}

const STATUSES: TodoStatus[] = ['pending', 'in_progress', 'completed'];
const MARK: Record<TodoStatus, string> = { pending: '[ ]', in_progress: '[~]', completed: '[x]' };

function renderTodos(todos: TodoItem[]): string {
  if (todos.length === 0) return 'Todo list is empty.';
  return todos.map((t) => `${MARK[t.status]} ${t.content}`).join('\n');
}

export default defineTool({
  name: 'todo_write',
  argAliases: {
    items: 'todos',
    list: 'todos',
    steps: 'todos',
    tasks: 'todos',
    text: 'content',
    task: 'content',
    title: 'content',
    step: 'content',
    description: 'content',
  },
  profiles: ['core'],
  category: 'agent',
  activity: 'Updating the task list',
  label: 'Todo Write',
  brief: 'Replace the task list for this conversation with the given one. Use for multi-step work only.',
  description:
    'Track a multi-step task as an explicit list, visible to the user throughout the turn. Use it whenever the user asks ' +
    'for a todo list, a checklist or steps to be tracked, and for any task with three or more steps. Call it with the ' +
    'full, updated list every time — it replaces whatever was there before, it does not append. Every item is ' +
    'an object with the step text in "content" and its state in "status" — ' +
    '{"todos": [{"content": "Read the failing test", "status": "in_progress"}]}. ' +
    'Mark exactly ' +
    'one task in_progress at a time, and update a task to completed as soon as it is genuinely done, not in a ' +
    'batch at the end. Skip this entirely for a single-step or trivial request.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full task list, in order. Replaces the previous list.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Short imperative description of the task' },
            status: { type: 'string', enum: STATUSES, description: 'Current state of this task' },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  tracksTasks: true,

  preview(args) {
    const todos = Array.isArray(args?.todos) ? args.todos : [];
    return `todo list: ${todos.length} task(s)`;
  },
  async execute(args, ctx) {
    if (!Array.isArray(args.todos)) {
      return fail('todos must be an array', { code: TOOL_ERROR_CODE.EINVAL });
    }

    const todos: TodoItem[] = [];
    for (const raw of args.todos) {
      const content = String((raw as any)?.content ?? '').trim();
      const status = (raw as any)?.status;
      if (!content) return fail('Each todo needs non-empty content', { code: TOOL_ERROR_CODE.EINVAL });
      if (!STATUSES.includes(status)) {
        return fail(`Invalid status "${status}" — must be one of: ${STATUSES.join(', ')}`, {
          code: TOOL_ERROR_CODE.EINVAL,
        });
      }
      todos.push({ content, status });
    }

    const inProgress = todos.filter((t) => t.status === 'in_progress');
    if (inProgress.length > 1) {
      return fail(`${inProgress.length} tasks are in_progress — keep at most one at a time`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Finish or pause the current task before starting the next one.',
      });
    }

    if (ctx.state) {
      ctx.state.todos = todos;
      // The list is the running task's; another task reading the same state must not take it for its own.
      ctx.state.todosTask = ctx.state.taskId;
    }

    return ok({ kind: 'status', display: renderTodos(todos), data: { todos } });
  },
});
