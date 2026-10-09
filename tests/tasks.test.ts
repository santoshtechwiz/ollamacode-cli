// The task list holds outcomes, in one place. todo_write's update changes only the tasks it names; a task is completed
// only on evidence; a failing command opens the tasks it proved again; a task waits for the ones it depends on.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import todoWrite from '../src/agent/planning/todo-write.tool';
import presentPlan from '../src/agent/planning/present-plan.tool';
import { createWorkspaceState, notePassed, passedNow } from '../src/context/workspace-state';
import { describeSession } from '../src/context/workspace-state';
import { ToolExecutor } from '../src/tool/core/tool-runtime';

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
      { task: 'Users can sign in', after: 'Auth works' },
      { task: 'Tokens refresh', after: 'Users can sign in' },
      { task: 'Deploy', content: 'The app is deployed' },
      { task: 'Auth works', remove: true },
    ] });
    assert.equal(r.ok, false, 'Deploy still depends on the removed task');
    assert.match(r.error, /depends on "Auth works", which is not in the list/);
    assert.deepEqual(names(state), ['pending: Auth works', 'pending: Deploy'], 'a refused change keeps the list as it was');

    const ok = await write(state, { update: [
      { task: 'Users can sign in', after: 'Auth works' },
      { task: 'Auth works', content: 'Sessions are stored' },
      { task: 'Deploy', content: 'The app is deployed' },
    ] });
    assert.equal(ok.ok, true, ok.error);
    assert.deepEqual(names(state), ['pending: Sessions are stored', 'pending: Users can sign in', 'pending: The app is deployed']);
    assert.deepEqual(state.todos[2].dependsOn, ['Sessions are stored'], 'a renamed task keeps the tasks that wait for it');
  });

  it('names the tasks there are when one is not found', async () => {
    const state: any = { todos: [{ content: 'A', status: 'pending' }] };
    const r = await write(state, { update: [{ task: 'B', remove: true }] });
    assert.match(r.error, /No task "B" to remove\. The tasks are: "A"/);
  });
});

describe('completed only on evidence', () => {
  it('a task with a verify command completes once it passed on the files as they are, and not before', async () => {
    const { root, state } = session();
    try {
      state.todos = [{ content: 'The tests pass', status: 'in_progress', verify: 'npm test' }];
      const early = await write(state, { update: [{ task: 'The tests pass', status: 'completed' }] });
      assert.equal(early.ok, false);
      assert.match(early.error, /`npm test` has not passed on the files as they are now\. Run it/);

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
    assert.match(bare.error, /give its evidence/);
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
