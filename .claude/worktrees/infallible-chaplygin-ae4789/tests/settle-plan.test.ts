import test from 'node:test';
import assert from 'node:assert/strict';
import { settlePlan } from '../src/agent/planning/settle';
import { AGENT_STATE, STOP_REASONS } from '../src/protocol';

function plan(files: string[]) {
  return {
    summary: 'add socket.io for realtime',
    files: { create: [...files], edit: [], del: [] },
    runs: [],
  };
}

function box(planRecord: unknown) {
  return {
    state: AGENT_STATE.COMPLETED,
    plan: planRecord,
    permissions: { plan_approved: true, action_approved: true },
    resumable: false,
  };
}

function world(changes: unknown[], todos: unknown) {
  return {
    cwd: process.cwd(),
    state: { changes, todos, planPath: null, plan: null, permissions: null, agentState: null },
  };
}

const todos = (...statuses: string[]) =>
  ['Install socket.io dependency', 'Wire the server', 'Wire the client', 'Run the tests'].map(
    (content, i) => ({ content, status: statuses[i] }),
  );

const todoWrite = { name: 'todo_write', result: { ok: true } };

test('a finished task list the model wrote this turn settles the plan', () => {
  const changes = [
    { change: 'create', path: 'package.json' },
    { change: 'edit', path: 'server.js' },
    { change: 'edit', path: 'public/app.js' },
  ];
  // The plan guessed six files. The model kept a four-item list instead and did all four.
  const result = {
    stopReason: STOP_REASONS.COMPLETE,
    content: 'Socket.io is wired up and the tests pass.',
    toolResults: [todoWrite, { name: 'write_file', result: { ok: true } }],
  };
  const state = box(plan(['package.json', 'server.js', 'public/app.js', 'vite.config.js', '.env', 'index.html']));

  settlePlan({ box: state, workspace: world(changes, todos('completed', 'completed', 'completed', 'completed')), result });

  assert.equal((result as any).planRemaining, 0);
  assert.ok((result as any).planChecklist.every((item: any) => item.status === 'done'));
  assert.equal(result.content, 'Socket.io is wired up and the tests pass.', 'plan bookkeeping must stay out of the answer');
  assert.equal(state.plan, null, 'a finished plan must not keep offering to resume');
  assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
});

test('a turn that ends with work still open ends the plan and says what is left', () => {
  const result = {
    stopReason: STOP_REASONS.COMPLETE,
    content: 'Wrote the tests.',
    toolResults: [todoWrite],
  };
  const state = box(plan(['package.json', 'server.js', 'public/app.js', 'vite.config.js', '.env', 'index.html']));

  settlePlan({
    box: state,
    workspace: world([{ change: 'create', path: 'package.json' }], todos('completed', 'completed', 'completed', 'pending')),
    result,
  });

  assert.equal((result as any).planChecklist.length, 6);
  assert.equal((result as any).planRemaining, 5);
  assert.equal(state.plan, null, 'a plan ends with the turn that ran it; nothing is left to come back later');
  assert.equal((result as any).planSummary.done, 1);
  assert.equal((result as any).planSummary.notDone.length, 5);
});

test('a list from an earlier turn does not count as this turn finishing the work', () => {
  const result = {
    stopReason: STOP_REASONS.COMPLETE,
    content: 'Answered a question.',
    toolResults: [{ name: 'read_file', result: { ok: true } }],
  };
  const state = box(plan(['a.js', 'b.js']));

  settlePlan({ box: state, workspace: world([{ change: 'edit', path: 'a.js' }], todos('completed', 'completed')), result });

  assert.equal((result as any).planChecklist.length, 2);
  assert.equal((result as any).planRemaining, 1);
  assert.equal((result as any).planSummary.done, 1, 'the earlier list did not mark b.js done');
  assert.deepEqual((result as any).planSummary.notDone, ['b.js']);
});

test('a cancelled turn on a plan with nothing to check stays cancelled and can be picked up again', () => {
  const b = box({ ...plan([]), steps: [] });
  const result: any = { content: '', toolResults: [], iterations: 1, stopReason: STOP_REASONS.CANCELLED };
  settlePlan({ box: b, workspace: world([], []), result });
  assert.equal(result.stopReason, STOP_REASONS.CANCELLED, 'nothing was shown done, so the cancel stands');
  assert.equal(b.resumable, true, 'the plan is left open for /continue');
});
