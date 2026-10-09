// Plan mode and the task list, without a model: nothing changes until the person approves the plan present_plan shows,
// the same turn then carries it out, and the task list is what the model last wrote.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import '../src/tool/index';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';
import { selectToolDefs } from '../src/context/tool-surface';
import { reportChatTurn } from '../src/cli/chat/turn/index';
import { STOP_REASONS } from '../src/protocol';
import presentPlan from '../src/agent/planning/present-plan.tool';
import todoWrite from '../src/agent/planning/todo-write.tool';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-plan-'));

/** A turn whose model makes the given calls, one per step, then answers; the tools run for real. */
async function planTurn(root: string, steps: Array<[string, Record<string, unknown>]>, answer: (question: string) => string, { agentMode = false } = {}) {
  const state: any = createWorkspaceState(root);
  state.planExploring = !agentMode;
  state.autoFixAuthorized = true;
  const asked: string[] = [];
  const ask = async (question: string, _options?: string[], opts?: { detail?: string }) => { asked.push(`${opts?.detail ?? ''}\n${question}`); return answer(question); };
  let step = 0;
  const result = await runTurn({
    model: 'test',
    history: new ContextStore({ messages: [], budgetTokens: 8000 }),
    config: { maxIterations: steps.length + 2 },
    // Every tool goes out in full, as executeTurn sends them.
    toolProfile: { always: selectToolDefs({}).map((def) => def.name) },
    cwd: root,
    state,
    ask,
    approve: async () => true,
    toolRunner: createExecutor({ root, state, approve: async () => true, ask } as any),
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream() {
        const call = steps[step++];
        const toolCalls = call ? [{ id: `c${step}`, type: 'function', function: { name: call[0], arguments: call[1] } }] : [];
        return { result: { content: call ? '' : 'Done.', toolCalls, finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
      },
    } as any,
  } as any);
  return { result, state, asked };
}

describe('plan mode', () => {
  const write = ['write_file', { path: 'a.txt', content: 'hi\n' }] as [string, Record<string, unknown>];
  const plan = ['present_plan', { plan: 'Create a.txt with "hi"; check it with cat a.txt.', folder: '.' }] as [string, Record<string, unknown>];

  it('refuses a change until the plan is approved, then the same turn carries it out', async () => {
    const root = tmp();
    try {
      const { result, state, asked } = await planTurn(root, [write, plan, write], () => 'Yes, start now');
      const [early, shown, late] = result.toolResults;
      assert.equal(early.result.ok, false, 'the write before approval is refused');
      assert.match(String(early.result.error), /plan mode/);
      assert.equal(shown.result.ok, true);
      assert.match(asked[0], /Create a\.txt[\s\S]*Start this plan now\?/);
      assert.equal(late.result.ok, true, 'the write after approval runs');
      assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'hi\n');
      assert.equal(state.planExploring, false, 'approval ended plan mode');
      assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('in agent mode, enter_plan_mode makes the turn plan first: changes wait for the approved plan', async () => {
    const root = tmp();
    try {
      const { result, state, asked } = await planTurn(root, [['enter_plan_mode', {}], write, plan, write], () => 'Yes, start now', { agentMode: true });
      const [entered, early, shown, late] = result.toolResults;
      assert.equal(entered.result.ok, true);
      assert.equal(early.result.ok, false, 'a change after entering plan mode is refused');
      assert.match(String(early.result.error), /plan mode/);
      assert.equal(shown.result.ok, true);
      assert.equal(asked.length, 1);
      assert.equal(late.result.ok, true, 'the approved plan is carried out in the same turn');
      assert.equal(state.planExploring, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("an approved plan's steps are the task list, and the model is told to mark them", async () => {
    const root = tmp();
    try {
      const steps = ['Create a.txt', 'Check it with cat'];
      const { result, state } = await planTurn(root, [['present_plan', { plan: 'Create a.txt; check it.', folder: '.', steps }]], () => 'Yes, start now');
      assert.deepEqual(state.todos, steps.map((content) => ({ content, status: 'pending' })));
      assert.match(String(result.toolResults[0].result.modelNote), /task list now:\n\[ \] Create a\.txt\n\[ \] Check it with cat\n[\s\S]*todo_write/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('"Change something" asks what, and the model hears it while nothing changes', async () => {
    const root = tmp();
    try {
      const { result, asked } = await planTurn(root, [plan, write], (q) => (q === 'Start this plan now?' ? 'Change something' : 'use b.txt instead'));
      assert.match(asked[1], /What should change in the plan\?/);
      const [shown, after] = result.toolResults;
      assert.match(String(shown.result.modelNote), /asked for changes: use b\.txt instead[\s\S]*present_plan again/);
      assert.equal(after.result.ok, false, 'still nothing may change');
      assert.ok(!fs.existsSync(path.join(root, 'a.txt')));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('declined, nothing changes for the rest of the turn', async () => {
    const root = tmp();
    try {
      const { result } = await planTurn(root, [plan, write], () => 'Not yet');
      assert.match(String(result.toolResults[0].result.modelNote), /did not start this plan/);
      assert.equal(result.toolResults[1].result.ok, false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('with nobody to ask, the plan is the answer, unless everything was approved up front', async () => {
    const held: any = { planExploring: true };
    const notAsked: any = await presentPlan.execute({ plan: 'x' }, { state: held } as any);
    assert.equal(notAsked.data.approved, false);
    assert.equal(held.planHeld, true);
    const upFront: any = { planExploring: true, autoFixAuthorized: true };
    const approved: any = await presentPlan.execute({ plan: 'x' }, { state: upFront } as any);
    assert.equal(approved.data.approved, true);
    assert.equal(upFront.planExploring, false);
  });
});

describe('the task list', () => {
  const write = (state: any, todos: unknown[]) => todoWrite.execute({ todos }, { state } as any) as Promise<any>;

  it('keeps one task in progress, and every task says what it is', async () => {
    const state: any = {};
    const two = await write(state, [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }]);
    assert.equal(two.ok, false);
    const blank = await write(state, [{ content: ' ', status: 'pending' }]);
    assert.equal(blank.ok, false);
    assert.equal(state.todos, undefined, 'a refused list is not kept');
  });

  it('ends the turn printed once; a finished list goes', async () => {
    const committed: any[] = [];
    const state: any = { todos: [{ content: 'GET /todos', status: 'completed' }, { content: 'POST /todos', status: 'completed' }] };
    const host: any = {
      render: { text: '', markdown: () => {}, note: () => {}, commitTasks: (list: any[]) => committed.push(list) },
      workspace: { state },
      interactive: false,
      flags: {},
    };
    await reportChatTurn(host, { content: 'Done.', toolResults: [], iterations: 2, stopReason: STOP_REASONS.COMPLETE } as any, {});
    assert.equal(committed.length, 1);
    assert.deepEqual(committed[0].map((i: any) => i.status), ['done', 'done']);
    assert.deepEqual(state.todos, []);
  });

  it('updating it never asks for approval', async () => {
    const { PermissionPolicy, createPermissions } = await import('../src/tool/policy/permission-policy.ts');
    const { TOOL_META } = await import('../src/tool/index.ts');
    const decision = await new PermissionPolicy().decide({
      toolName: 'todo_write', args: { todos: [] }, toolDef: TOOL_META.todo_write, cwd: process.cwd(), root: process.cwd(),
      permissions: createPermissions(), yes: false, policy: 'ask', interactive: true,
    } as any);
    assert.equal(decision, 'allow');
  });
});

describe('what the screen never shows', () => {
});
