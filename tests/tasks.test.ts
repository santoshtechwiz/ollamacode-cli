// The task list holds outcomes, in one place. todo_write's update changes only the tasks it names; a task is completed
// only on evidence; a failing command opens the tasks it proved again; a task waits for the ones it depends on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import todoWrite from '../src/agent/planning/todo-write.tool';
import presentPlan from '../src/agent/planning/present-plan.tool';
import { createWorkspaceState, notePassed, passedNow, describeSession } from '../src/context/workspace-state';
import { ToolExecutor } from '../src/tool/core/tool-runtime';
import { reportChatTurn } from '../src/cli/chat/turn/index';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { STOP_REASONS } from '../src/protocol';
import '../src/tool/index';
import { prepareCall } from '../src/tool/execution/prepare';

const write = (state: any, args: Record<string, unknown>) => todoWrite.execute(args, { state } as any) as Promise<any>;
const names = (state: any) => state.todos.map((t: any) => `${t.status}: ${t.content}`);

function session() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-tasks-'));
  return { root, state: Object.assign(createWorkspaceState(root), { autoFixAuthorized: true }) as any };
}

describe('update', () => {
  it('changes the tasks it names and leaves the rest exactly as they were', async () => {
    const state: any = { todos: [
      { content: 'The API serves GET /todos', status: 'in_progress', doneWhen: 'it returns the saved tasks' },
      { content: 'The page lists tasks', status: 'pending', dependsOn: ['The API serves GET /todos'] },
    ] };
    const kept = state.todos[1];
    const r = await write(state, { update: [{ task: 'The API serves GET /todos', status: 'completed', evidence: 'curl /todos returned []' }] });
    assert.equal(r.ok, true, r.error);
    assert.equal(state.todos[1], kept, 'the task not named is the same task, untouched');
    assert.equal(state.todos[0].doneWhen, 'it returns the saved tasks', 'fields not sent are kept');
  });

  it('adds, places, splits, renames and removes when what was found changes the plan', async () => {
    const state: any = { todos: [{ content: 'Auth works', status: 'pending' }, { content: 'Deploy', status: 'pending', dependsOn: ['Auth works'] }] };
    const r = await write(state, { update: [
      { task: 'Users can sign in', add: true, after: 'Auth works' },
      { task: 'Tokens refresh', add: true, after: 'Users can sign in' },
      { task: 'Deploy', content: 'The app is deployed' },
      { task: 'Auth works', remove: true },
    ] });
    assert.equal(r.ok, false, 'Deploy still depends on the removed task');
    assert.match(r.error, /depends on "Auth works", which is not in the list/);
    assert.deepEqual(names(state), ['pending: Auth works', 'pending: Deploy'], 'a refused change keeps the list as it was');

    const ok = await write(state, { update: [
      { task: 'Users can sign in', add: true, after: 'Auth works' },
      { task: 'Auth works', content: 'Sessions are stored' },
      { task: 'Deploy', content: 'The app is deployed' },
    ] });
    assert.equal(ok.ok, true, ok.error);
    assert.deepEqual(names(state), ['pending: Sessions are stored', 'pending: Users can sign in', 'pending: The app is deployed']);
    assert.deepEqual(state.todos[2].dependsOn, ['Sessions are stored'], 'a renamed task keeps the tasks that wait for it');
  });

  it('never adds a task for a name it does not know: it names the tasks there are', async () => {
    const state: any = { todos: [{ content: 'Scaffold the project', status: 'in_progress', verify: 'ls' }] };
    // Seen in a session: a name with something appended added a second copy of the task.
    const r = await write(state, { update: [{ task: 'Scaffold the project, verify: Get-ChildItem', status: 'pending' }] });
    assert.match(r.error, /No task "Scaffold the project, verify: Get-ChildItem"\. The tasks are: "Scaffold the project"\. Name one exactly, or pass add: true/);
    assert.equal(state.todos.length, 1);
  });
});

describe('completed only on evidence', () => {
  it('a task with a verify command completes once it passed on the files as they are, and not before', async () => {
    const { root, state } = session();
    try {
      state.todos = [{ content: 'The tests pass', status: 'in_progress', verify: 'npm test' }];
      const early = await write(state, { update: [{ task: 'The tests pass', status: 'completed' }] });
      assert.equal(early.ok, false);
      assert.match(early.error, /`npm test` has not passed on the files as they are now\. Run that command/);

      notePassed(state, path.join(root, 'app'), 'npm test');
      const done = await write(state, { update: [{ task: 'The tests pass', status: 'completed' }] });
      assert.equal(done.ok, true, done.error);

      state.note('write', 'app/a.ts', 'file');
      assert.equal(passedNow(state, 'npm test'), false);
      assert.match(describeSession(state), /\[x\] The tests pass — verify: `npm test` · changed since it was checked/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a task no command proves needs what showed it works', async () => {
    const state: any = { todos: [{ content: 'The folder is chosen', status: 'in_progress' }] };
    const bare = await write(state, { update: [{ task: 'The folder is chosen', status: 'completed' }] });
    assert.match(bare.error, /send evidence with it/);
    const r = await write(state, { update: [{ task: 'The folder is chosen', status: 'completed', evidence: 'the user picked ./shop' }] });
    assert.equal(r.ok, true, r.error);
  });

  it('a task already completed is not proved again when the list is written whole', async () => {
    const state: any = { todos: [{ content: 'Built', status: 'completed', verify: 'npm run build' }] };
    const r = await write(state, { todos: [{ content: 'Built', status: 'completed', verify: 'npm run build' }, { content: 'Docs', status: 'pending' }] });
    assert.equal(r.ok, true, r.error);
  });

  it('a task starts only after the tasks it depends on are completed', async () => {
    const state: any = { todos: [{ content: 'API', status: 'pending' }, { content: 'Page', status: 'pending', dependsOn: ['API'] }] };
    const r = await write(state, { update: [{ task: 'Page', status: 'in_progress' }] });
    assert.match(r.error, /"Page" cannot start before "API" is completed/);
  });
});

describe('a failed command', () => {
  it('opens the completed task it proved again, saying why, and its earlier pass no longer counts', async () => {
    const { root, state } = session();
    const ex = new ToolExecutor({ root, state });
    const check = 'node -e "process.exit(Number(process.argv[1]))"';
    try {
      assert.equal((await ex.run('exec_shell', { command: `${check} 0` })).result.ok, true);
      state.todos = [{ content: 'It builds', status: 'in_progress', verify: `${check} 0` }];
      assert.equal((await write(state, { update: [{ task: 'It builds', status: 'completed' }] })).ok, true);

      // The same check, now failing (a dependency changed underneath, say): the task is open again.
      state.todos[0].verify = `${check} 1`;
      const failed = (await ex.run('exec_shell', { command: `${check} 1` })).result;
      assert.equal(failed.ok, false);
      assert.equal(state.todos[0].status, 'pending');
      assert.match(state.todos[0].reopened, /failed after it was completed/);
      const again = await write(state, { update: [{ task: 'It builds', status: 'completed' }] });
      assert.equal(again.ok, false, 'not completed again until the command passes');
    } finally {
      state.reset?.();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});

describe('an approved plan', () => {
  it('is the task list, changed afterwards one task at a time', async () => {
    const { root, state } = session();
    try {
      await presentPlan.execute(
        { plan: 'Build the shop.', folder: 'shop', steps: ['The API serves products', 'The page lists products'] },
        { state, root, cwd: root, ask: async () => 'Yes, start now' } as any,
      );
      const r = await write(state, { update: [{ task: 'The page lists products', doneWhen: 'products from the API show on /', dependsOn: ['The API serves products'] }] });
      assert.equal(r.ok, true, r.error);
      assert.equal(r.display, '[ ] The API serves products\n[ ] The page lists products — after: The API serves products · done when: products from the API show on /');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('what the session showed', () => {
  it('a verify that is no command can be taken off, and the task completed on evidence', async () => {
    const state: any = { todos: [{ content: 'The hook saves notes', status: 'in_progress', verify: 'Read `src/hooks/useNotes.ts`' }] };
    const stuck = await write(state, { update: [{ task: 'The hook saves notes', status: 'completed' }] });
    assert.match(stuck.error, /If no command proves this task, send verify: "" with status completed and evidence/);
    const r = await write(state, { update: [{ task: 'The hook saves notes', status: 'completed', verify: '', evidence: 'a saved note is still there after reload' }] });
    assert.equal(r.ok, true, r.error);
    assert.equal(state.todos[0].verify, undefined);
  });

  it('evidence written before the work is not kept, so it cannot complete the task later', async () => {
    const state: any = {};
    await write(state, { todos: [{ content: 'Scaffolded', status: 'in_progress', evidence: 'ls ./notes-app' }] });
    assert.equal(state.todos[0].evidence, undefined);
    const r = await write(state, { update: [{ task: 'Scaffolded', status: 'completed' }] });
    assert.equal(r.ok, false);
  });

  it('an answer over open tasks says on screen which are not done', async () => {
    const notes: string[] = [];
    const state: any = { todos: [{ content: 'Notes persist', status: 'completed', evidence: 'reload kept them' }, { content: 'Search filters notes', status: 'in_progress' }] };
    const host: any = {
      render: { text: '', markdown: () => {}, note: (text: string) => notes.push(text), commitTasks: () => {} },
      workspace: { state }, interactive: false, flags: {},
    };
    await reportChatTurn(host, { content: 'All tasks are done.', toolResults: [], iterations: 3, stopReason: STOP_REASONS.COMPLETE } as any, {});
    assert.ok(notes.includes('Not finished: 1 of 2 tasks are still open (Search filters notes).'), notes.join(' | '));
  });
});

describe('the list follows the work', () => {
  it('ticks the task in progress when its command passes, and no other', async () => {
    const { root, state } = session();
    try {
      state.todos = [
        { content: 'The page builds', status: 'in_progress', verify: 'npm run build' },
        { content: 'Skeletons show while loading', status: 'pending', verify: 'npm run build' },
      ];
      notePassed(state, path.join(root, 'app'), 'npm run build');
      assert.deepEqual(names(state), ['completed: The page builds', 'pending: Skeletons show while loading'],
        'a pending task\'s command can pass before its work exists');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('starting the next task is never refused: the one in progress goes back to pending', async () => {
    const state: any = { todos: [{ content: 'NoteList is accessible', status: 'in_progress' }, { content: 'The editor saves', status: 'pending' }] };
    const r = await write(state, { update: [{ task: 'The editor saves', status: 'in_progress' }] });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(names(state), ['pending: NoteList is accessible', 'in_progress: The editor saves']);
  });
});

describe('an answer over open tasks after changing files', () => {
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: args } });

  async function turn(replies: any[]) {
    const { root, state } = session();
    const requests: any[] = [];
    const notes: string[] = [];
    const history = new ContextStore({ messages: [{ role: 'user', content: 'polish the notes page' }], budgetTokens: 8000 });
    const result: any = await (runTurn as any)({
      model: 'test', history, toolsEnabled: true, state, config: { maxIterations: 10 },
      callbacks: { note: (text: string) => notes.push(text) },
      gateway: {
        model: 'test', provider: { id: 'test' },
        async stream(request: any) {
          requests.push(request);
          const next = replies[requests.length - 1] ?? { content: 'Done.' };
          return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      },
      toolRunner: {
        async run(name: string, args: any) {
          if (name === 'todo_write') return { result: await todoWrite.execute(args, { state } as any) };
          state.note('write', String(args.path), 'file');
          return { result: { ok: true, kind: 'text', display: 'ok' } };
        },
      },
    });
    fs.rmSync(root, { recursive: true, force: true });
    return { requests, notes, result, state };
  }

  const LIST = call('1', 'todo_write', { todos: [{ content: 'The list has dark mode', status: 'in_progress' }, { content: 'Notes fade in', status: 'pending' }] });
  const EDIT = call('2', 'write_file', { path: 'notes-app/src/NoteList.tsx', content: 'x' });

  it('goes back once with the list, and a settled list lets the answer stand', async () => {
    const t = await turn([
      { toolCalls: [LIST] }, { toolCalls: [EDIT] }, { content: 'All done.' },
      { toolCalls: [call('3', 'todo_write', { update: [
        { task: 'The list has dark mode', status: 'completed', evidence: 'the page check passed in dark mode' },
        { task: 'Notes fade in', remove: true },
      ] })] },
      { content: 'Dark mode is done; I did not add the fade-in.' },
    ]);
    const seen = t.requests[3].messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content)).at(-1);
    assert.match(seen, /Your answer leaves 2 tasks open/);
    assert.match(seen, /\[~\] The list has dark mode/);
    assert.equal(t.result.answer, 'Dark mode is done; I did not add the fade-in.');
    assert.deepEqual(names(t.state), ['completed: The list has dark mode']);
    assert.ok(t.notes.some((n) => /2 tasks are still open after that answer/.test(n)));
  });

  it('asks once: a model that answers again over an open list is not sent back again', async () => {
    const t = await turn([{ toolCalls: [LIST] }, { toolCalls: [EDIT] }, { content: 'All done.' }, { content: 'All done, really.' }]);
    assert.equal(t.requests.length, 4);
    assert.equal(t.result.answer, 'All done, really.');
  });
});

describe('task-list-shown', () => {
  const LIST = [
    { content: 'Implement the Result pattern', status: 'completed' as const },
    { content: 'Validate configuration on start', status: 'in_progress' as const },
    { content: 'Test UserService', status: 'pending' as const },
  ];

  describe('the task list', () => {

    it('the session record shows the model its list every request', () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-todos-'));
      try {
        const state: any = createWorkspaceState(cwd);
        state.todos = LIST;
        assert.match(describeSession(state), /Your task list.*\n\[x\] Implement the Result pattern\n\[~\] Validate configuration on start\n\[ \] Test UserService/);
        state.reset?.();
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });
  });
});

describe('array-item-errors', () => {
  const errorOf = (name: string, args: Record<string, unknown>) => {
    const r: any = prepareCall(name, args);
    return r.ok ? null : String(r.result.error);
  };

  describe('a wrong list item says what an item is, from the schema', () => {
    it('an object item names its fields and what was sent', () => {
      assert.equal(errorOf('todo_write', { todos: ['Install deps'] }), 'todos[0] must be an object {content, status}, received a string');
    });
  });
});
