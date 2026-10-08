import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runPlanApprovalLoop } from '../src/agent/planning/plan-loop';
import { recordStoppedPlan } from '../src/agent/turn/index';
import presentPlan from '../src/agent/planning/present-plan.tool';
import { createAgentState } from '../src/agent/state';
import { ContextStore } from '../src/context/store';
import { createWorkspaceState } from '../src/context/workspace-state';
import { PLAN_DECISION, ROLE, STOP_REASONS } from '../src/protocol';

type Reply = { content?: string; toolCalls?: any[] };

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, type: 'function', function: { name, arguments: args } });

const PLAN = [
  'Goal',
  'Add shipping() to the cart in src/cart.js.',
  '',
  'Implementation',
  '1. Add a shipping() method; File: src/cart.js',
  '',
  'Validation',
  '1. Run: npm test',
].join('\n');

// Plan mode with a scripted model: the plan loop's own read-only turn, then the approval prompt.
async function planMode(replies: Reply[], run?: (name: string, args: any) => any, signal?: AbortSignal) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-plan-'));
  const workspace: any = { cwd, state: createWorkspaceState(cwd), nativeTools: true };
  workspace.state.readOnlyMode = 'plan';
  const requests: any[] = [];
  const ran: string[] = [];
  const shown: any[] = [];
  const outcome = await runPlanApprovalLoop({
    box: createAgentState(),
    workspace,
    provider: {},
    model: 'test',
    system: [],
    task: 'Add a shipping() method to the cart',
    config: { maxIterations: 6 },
    signal,
    profile: { brief: false, compact: false, core: true, autoContextBudget: 1000 },
    onPlan: async (plan: any) => {
      shown.push(plan);
      return { decision: PLAN_DECISION.APPROVE };
    },
    replanFrom: null,
    history: new ContextStore({ messages: [], budgetTokens: 8000 }),
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        requests.push(request);
        const next = replies[requests.length - 1] ?? { content: '' };
        return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
      },
    },
    toolRunner: {
      async run(name: string, args: any) {
        ran.push(name);
        if (run) return { result: run(name, args) };
        if (name === 'present_plan') return { result: await presentPlan.execute(args, { state: workspace.state } as any) };
        return { result: { ok: true, kind: 'text', display: 'export class Cart {}' } };
      },
    },
  } as any);
  fs.rmSync(cwd, { recursive: true, force: true });
  return { outcome, requests, ran, shown };
}

describe('plan mode', () => {
  it('looks at the code first, then puts the plan it presented to the user', async () => {
    const t = await planMode([
      { toolCalls: [call('1', 'read_file', { path: 'src/cart.js' })] },
      { toolCalls: [call('2', 'present_plan', { plan: PLAN })] },
      { content: 'The plan is ready for your approval.' },
    ]);
    assert.deepEqual(t.ran, ['read_file', 'present_plan']);
    assert.equal(t.shown.length, 1, 'the plan reached the approval prompt');
    assert.match(t.shown[0].raw, /shipping\(\)/);
    assert.deepEqual(t.outcome, { kind: 'proceed', approved: true });
    const offered = t.requests[0].tools.map((tool: any) => tool.function?.name ?? tool.name);
    assert.ok(offered.includes('present_plan'), 'plan mode offers present_plan');
    assert.ok(!offered.includes('write_file') && !offered.includes('edit_file'), 'plan mode offers no tool that changes files');
  });

  it('takes the plan a model writes as its answer when it does not call present_plan', async () => {
    const t = await planMode([
      { toolCalls: [call('1', 'read_file', { path: 'src/cart.js' })] },
      { content: PLAN },
    ]);
    assert.equal(t.shown.length, 1);
    assert.match(t.shown[0].raw, /shipping\(\)/);
    assert.deepEqual(t.outcome, { kind: 'proceed', approved: true });
  });

  it('stops without changing anything when the model presents no plan', async () => {
    const t = await planMode([{ content: '' }]);
    assert.equal(t.shown.length, 0);
    assert.equal(t.outcome.kind, 'stop');
  });

  it('reports a cancel during exploration as a cancel, not as a missing plan', async () => {
    const controller = new AbortController();
    const t = await planMode(
      [{ toolCalls: [call('1', 'read_file', { path: 'src/cart.js' })] }],
      () => {
        // The person presses Ctrl-C while the model is looking at the code.
        controller.abort();
        return { ok: true, kind: 'text', display: 'export class Cart {}' };
      },
      controller.signal,
    );
    assert.equal(t.outcome.kind, 'stop');
    assert.equal(t.outcome.result?.stopReason, STOP_REASONS.CANCELLED);
    assert.equal(t.shown.length, 0, 'nothing reached the approval prompt');
  });

  it('saves a plan nobody approved after the request it answers', () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    recordStoppedPlan(history, 'Add a shipping() method to the cart', { raw: PLAN });
    assert.deepEqual(
      history.messages.map((m) => [m.role, m.content]),
      [[ROLE.USER, 'Add a shipping() method to the cart'], [ROLE.ASSISTANT, PLAN]],
      'a later "approved" must follow the plan, and the plan must follow its request',
    );
  });

  it('answers a question asked in plan mode instead of showing it as a plan', async () => {
    const answer = [
      'NOTHING_TO_CHANGE',
      '## C# 12 features',
      '',
      '- **Primary constructors** for any class or struct: `class Point(int x, int y)`.',
      '- **Collection expressions**: `int[] a = [1, 2, 3];`',
      '- **Default lambda parameters**: `var inc = (int x = 1) => x + 1;`',
    ].join('\n');
    const t = await planMode([{ content: answer }]);
    assert.equal(t.shown.length, 0, 'nothing went to the plan approval box');
    assert.equal(t.outcome.kind, 'stop');
    assert.equal(t.outcome.result?.stopReason, STOP_REASONS.COMPLETE);
    assert.match(t.outcome.result?.content ?? '', /^## C# 12 features\n\n- \*\*Primary constructors\*\*/, 'the whole answer, markdown and lines intact');
    assert.match(t.outcome.result?.content ?? '', /Default lambda parameters/);
    assert.equal(t.outcome.answer, t.outcome.result?.content);
  });

  it('keeps the answer in the conversation, so a follow-up question has it', () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    recordStoppedPlan(history, 'explain C# 12 features', undefined, '## C# 12 features\n- Primary constructors');
    assert.deepEqual(
      history.messages.map((m) => [m.role, m.content]),
      [[ROLE.USER, 'explain C# 12 features'], [ROLE.ASSISTANT, '## C# 12 features\n- Primary constructors']],
    );
  });
});
