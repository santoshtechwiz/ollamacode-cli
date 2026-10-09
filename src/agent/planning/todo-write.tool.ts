import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../../tool/core/defineTool';
import { ok, fail } from '../../tool/core/tool-result';
import { passedNow } from '../../context/workspace-state';
import { applyUpdates, checkTodos, todoFrom, todoLines, TODO_STATUSES, type TodoItem, type TodoStatus } from '../todos';

const TASK_FIELDS = {
  doneWhen: { type: 'string', description: 'What must be true for it to count as done' },
  verify: { type: 'string', description: 'A command whose pass proves it, e.g. "npm test" or "dotnet build"' },
  dependsOn: { type: 'array', items: { type: 'string' }, description: 'Outcomes of the tasks that must be completed first' },
  evidence: { type: 'string', description: 'For a task with no verify command: what showed it works' },
} as const;

export default defineTool({
  name: 'todo_write',
  profiles: ['core'],
  category: 'agent',
  activity: 'Updating the task list',
  label: 'Todo Write',
  brief: 'Track work of three or more steps as outcomes; change the tasks you name with update.',
  description:
    'Track work of three or more steps (or any the user wants tracked) as a list the user sees. Each task is an outcome ' +
    '(what will work), not a step of typing: "the /todo page adds and deletes tasks", not "edit Todo.razor". Give it ' +
    'doneWhen, and verify when a command proves it. Change tasks with update, naming each by its outcome: set a status, ' +
    'add, split (add the parts, remove the whole), reorder (after), or remove one when what you learn changes the plan; ' +
    'tasks you do not name stay as they are. todos replaces the whole list. One task in_progress at a time. A task is ' +
    'completed only on evidence: its verify command passed on the files as they are now (run it first), or, with no ' +
    'command, evidence saying what showed it works. A verify command that fails later opens its task again. ' +
    'Skip this for a one-step request.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full task list, in order; it replaces the current one.',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The outcome: what will work when it is done' },
            status: { type: 'string', enum: TODO_STATUSES as TodoStatus[] },
            ...TASK_FIELDS,
          },
          required: ['content', 'status'],
        },
      },
      update: {
        type: 'array',
        description: 'Changes to tasks named by their outcome; a name not in the list adds a task. The others stay as they are.',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'The outcome of the task to change, as listed, or of a new task' },
            status: { type: 'string', enum: TODO_STATUSES as TodoStatus[] },
            content: { type: 'string', description: 'New wording for the outcome' },
            ...TASK_FIELDS,
            after: { type: 'string', description: 'Move it after this task (by outcome)' },
            remove: { type: 'boolean', description: 'Remove the task: no longer needed, or split into others' },
          },
          required: ['task'],
        },
      },
    },
    requiredOneOf: [['todos'], ['update']],
  },
  tracksTasks: true,

  preview(args) {
    if (Array.isArray(args?.update)) return `todo list: ${args.update.length} change(s)`;
    const todos = Array.isArray(args?.todos) ? args.todos : [];
    return `todo list: ${todos.length} task(s)`;
  },

  async execute(args, ctx) {
    const state = ctx.state as any;
    const before: TodoItem[] = state?.todos ?? [];
    const next = Array.isArray(args.update) ? applyUpdates(before, args.update as any[]) : (args.todos as any[]).map(todoFrom);
    if (typeof next === 'string') return fail(next, { code: TOOL_ERROR_CODE.EINVAL });
    const passed = (command: string) => passedNow(state, command);
    const wrong = checkTodos(next, before, passed);
    if (wrong) return fail(wrong, { code: TOOL_ERROR_CODE.EINVAL });
    if (state) state.todos = next;
    return ok({ kind: 'status', display: next.length ? todoLines(next, passed).join('\n') : 'Todo list is empty.', data: { todos: next } });
  },
});
