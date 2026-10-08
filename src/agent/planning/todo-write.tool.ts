import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../../tool/core/defineTool';
import { ok, fail } from '../../tool/core/tool-result';
import { TODO_STATUSES, todoLines, type TodoItem, type TodoStatus } from '../todos';

export default defineTool({
  name: 'todo_write',
  profiles: ['core'],
  category: 'agent',
  activity: 'Updating the task list',
  label: 'Todo Write',
  brief: 'Replace the task list with the given one. Use for work of three or more steps.',
  description:
    'Track work of three or more steps (or any the user wants tracked) as a list the user sees. Send the whole list each ' +
    'time; it replaces the last one. Mark a task in_progress before you start it (one at a time) and completed as soon as ' +
    'it is done. Skip this for a one-step request.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full task list, in order.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'What the task does, in a few words' },
            status: { type: 'string', enum: TODO_STATUSES as TodoStatus[] },
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
    const todos: TodoItem[] = (args.todos as any[]).map((raw) => ({ content: String(raw?.content ?? '').trim(), status: raw?.status }));
    if (todos.some((todo) => !todo.content)) return fail('Each task needs non-empty content', { code: TOOL_ERROR_CODE.EINVAL });
    if (todos.filter((todo) => todo.status === 'in_progress').length > 1) {
      return fail('More than one task is in_progress — keep one at a time', { code: TOOL_ERROR_CODE.EINVAL });
    }
    if (ctx.state) (ctx.state as any).todos = todos;
    return ok({ kind: 'status', display: todos.length ? todoLines(todos).join('\n') : 'Todo list is empty.', data: { todos } });
  },
});
