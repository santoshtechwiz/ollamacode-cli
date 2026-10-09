// Subagents end to end, with no model: one scripted gateway answers the parent and the child (told apart by the
// child's instruction), the real executor runs the real tools in a scratch folder, and runTurn is the real turn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import '../src/tool/index';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentState } from '../src/agent/state';
import { createExecutor } from '../src/tool/execution/executor';
import { applyApprovalPolicy } from '../src/tool/policy/permission-policy';
import { createSubagentRunner, type ParentTurn } from '../src/agent/subagent/runner';
import { CHILD_EXCLUDED_TOOLS, MAX_DELEGATIONS_PER_TURN, SUBAGENT_ROLES, allRoles } from '../src/agent/subagent/roles';
import { CancelError, isCancel } from '../src/core/errors';
import { ROLE, STOP_REASONS } from '../src/protocol';

type Reply = { content?: string; toolCalls?: any[] };
const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, type: 'function', function: { name, arguments: args } });
const isChild = (request: any) => (request.messages ?? []).some((m: any) => m.role === ROLE.SYSTEM && /You are a subagent/.test(String(m.content)));
const toolNames = (request: any) => (request.tools ?? []).map((t: any) => t.function?.name);

async function session(
  { parent, child, subagents, files = { 'app.js': 'const PORT = 3000;\n' }, signal, before, native = true }:
  { parent: Reply[]; child: Reply[]; subagents?: boolean; files?: Record<string, string>; signal?: AbortSignal; before?: (state: any) => void; native?: boolean },
) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-subagent-'));
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(cwd, rel), text);
  const state: any = createWorkspaceState(cwd);
  state.permissions = createAgentState().permissions;
  applyApprovalPolicy(state, { yes: true });
  before?.(state);
  const asked = { parent: [] as any[], child: [] as any[] };
  const history = new ContextStore({ messages: [{ role: ROLE.USER, content: 'do the task' }], budgetTokens: 16_000 });
  try {
    const result = await runTurn({
      model: 'test',
      history,
      systemMessages: [{ role: ROLE.SYSTEM, content: 'You are ocode.' }],
      // No subagents key unless a test sets one: on is the default.
      config: { maxIterations: 8, ...(subagents === undefined ? {} : { subagents }) },
      toolsEnabled: true,
      cwd,
      state,
      signal,
      toolProfile: { native, always: ['read_file', 'edit_file', 'todo_write', 'delegate_task'] },
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream(request: any) {
          const who = isChild(request) ? 'child' : 'parent';
          asked[who].push(request);
          const next = (who === 'child' ? child : parent)[asked[who].length - 1] ?? { content: '' };
          return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: createExecutor({ root: cwd, state, timeoutMs: 20_000 }),
    } as any);
    const toolMessage = (id: string) => String(history.messages.find((m: any) => m.role === ROLE.TOOL && m.tool_call_id === id)?.content ?? '');
    // Read before the folder is removed.
    const after = Object.fromEntries(Object.keys(files).map((rel) => [rel, fs.readFileSync(path.join(cwd, rel), 'utf8')]));
    return { result, history, state, asked, toolMessage, file: (rel: string) => after[rel] };
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

describe('delegating to a subagent', () => {
  it('the parent delegates, waits, and carries on with the child\'s report', async () => {
    const s = await session({
      parent: [{ toolCalls: [call('p1', 'delegate_task', { role: 'research', task: 'Which port does app.js listen on?' })] }, { content: 'It listens on 3000.' }],
      child: [{ toolCalls: [call('c1', 'read_file', { path: 'app.js' })] }, { content: 'app.js line 1 sets PORT to 3000.' }],
    });
    assert.equal(s.result.content, 'It listens on 3000.');
    assert.equal(s.result.stopReason, STOP_REASONS.COMPLETE);
    assert.match(s.toolMessage('p1'), /app\.js line 1 sets PORT to 3000\./);
    assert.match(s.toolMessage('p1'), /\[research subagent · \d+ steps? · changed no files · used read_file\]/);
  });

  it('keeps the child\'s conversation apart: saved on the session, never in the parent\'s history', async () => {
    const s = await session({
      parent: [{ toolCalls: [call('p1', 'delegate_task', { role: 'research', task: 'Read app.js', context: 'The port is on line 1.' })] }, { content: 'Done.' }],
      child: [{ toolCalls: [call('c1', 'read_file', { path: 'app.js' })] }, { content: 'Read it.' }],
    });
    const parentCalls = s.history.messages.flatMap((m: any) => (m.tool_calls ?? []).map((c: any) => c.function.name));
    assert.deepEqual(parentCalls, ['delegate_task'], 'the child\'s read_file is not the parent\'s');
    assert.equal(s.state.subagentRuns.length, 1);
    const run = s.state.subagentRuns[0];
    assert.equal(run.role, 'research');
    assert.ok(run.messages.some((m: any) => (m.tool_calls ?? []).some((c: any) => c.function.name === 'read_file')));
    // The child starts from the task and its context alone.
    const firstChild = s.asked.child[0].messages.filter((m: any) => m.role === ROLE.USER).map((m: any) => String(m.content));
    assert.equal(firstChild.length, 1);
    // After the workspace block every request carries, the person's words are the task and its context, nothing else.
    assert.match(firstChild[0], /\n\nRead app\.js\n\nContext from the agent that delegated this:\nThe port is on line 1\.$/);
    assert.ok(!firstChild.some((u) => u === 'do the task'), 'none of the parent\'s conversation');
  });

  it('a coding child\'s changes are real, and the parent is told which files changed', async () => {
    const s = await session({
      parent: [{ toolCalls: [call('p1', 'delegate_task', { role: 'coding', task: 'Set the port to 8080 in app.js' })] }, { content: 'Changed.' }],
      child: [
        { toolCalls: [call('c0', 'read_file', { path: 'app.js' })] },
        { toolCalls: [call('c1', 'edit_file', { path: 'app.js', search: 'const PORT = 3000;', replace: 'const PORT = 8080;' })] },
        { content: 'Set PORT to 8080.' },
      ],
    });
    assert.equal(s.file('app.js'), 'const PORT = 8080;\n');
    assert.match(s.toolMessage('p1'), /changed app\.js/);
  });
});

describe('what a child may do', () => {
  it('is offered its role\'s tools only: never delegate_task, todo_write, present_plan or ask_user, and no edits when read-only', async () => {
    const s = await session({
      parent: [{ toolCalls: [call('p1', 'delegate_task', { role: 'research', task: 'Look around' })] }, { content: 'Done.' }],
      child: [{ content: 'Nothing to report.' }],
    });
    const offered = toolNames(s.asked.child[0]);
    for (const name of [...CHILD_EXCLUDED_TOOLS, 'edit_file', 'write_file']) assert.ok(!offered.includes(name), `${name} offered to a research child`);
    assert.ok(offered.includes('read_file'));
    // Research looks things up on the web too: those tools read and change nothing in the project.
    for (const name of ['web_search', 'web_fetch']) assert.ok(offered.includes(name), `${name} not offered to a research child`);
    assert.ok(toolNames(s.asked.parent[0]).includes('delegate_task'), 'the parent is offered it, with no setting at all');
  });

  for (const native of [true, false]) it(`a call to a tool outside its role is refused at the child's runner, and nothing changes (${native ? 'tool channel' : 'text mode, where no tool list is sent'})`, async () => {
    const parentList = [{ content: 'parent step', status: 'pending' }];
    const s = await session({
      native,
      before: (state) => {
        state.todos = parentList;
        state.todosTask = state.taskId;
      },
      parent: [{ toolCalls: [call('p1', 'delegate_task', { role: 'research', task: 'Look at app.js' })] }, { content: 'Done.' }],
      child: [
        { toolCalls: [
          call('c1', 'edit_file', { path: 'app.js', search: 'const PORT = 3000;', replace: 'const PORT = 1;' }),
          call('c2', 'todo_write', { todos: [{ content: 'child step', status: 'pending' }] }),
          call('c3', 'delegate_task', { role: 'coding', task: 'go deeper' }),
        ] },
        { content: 'I could only look.' },
      ],
    });
    assert.equal(s.file('app.js'), 'const PORT = 3000;\n', 'a read-only child changed a file');
    assert.deepEqual(s.state.todos, parentList, 'a child replaced the parent\'s task list');
    const grandchild = s.asked.child.some((r: any) => r.messages.some((m: any) => m.role === ROLE.USER && /go deeper/.test(String(m.content))));
    assert.equal(grandchild, false, 'a child started a subagent of its own');
    assert.equal(s.state.subagentRuns.length, 1);
    const childResults = s.state.subagentRuns[0].messages.filter((m: any) => m.role === ROLE.TOOL).map((m: any) => String(m.content));
    assert.equal(childResults.length, 3);
    for (const text of childResults) assert.match(text, /^ERROR /);
    // Not run, so the person sees a dim "not run" line, not a red failure.
    for (const text of childResults) assert.match(text, /\[EBLOCKED\].*not available to a research subagent — not run/);
  });

  it('switched off (subagents: false): not offered, and a call to it starts nothing', async () => {
    const s = await session({
      subagents: false,
      parent: [{ toolCalls: [call('p1', 'delegate_task', { role: 'research', task: 'Which port?' })] }, { content: 'I will look myself.' }],
      child: [{ content: 'should never run' }],
    });
    assert.ok(!toolNames(s.asked.parent[0]).includes('delegate_task'));
    assert.equal(s.asked.child.length, 0);
    assert.match(s.toolMessage('p1'), /^ERROR delegate_task/);
    assert.equal(s.state.subagentRuns, undefined);
  });
});

// The runner alone, with a stand-in for the child's turn: how it judges what came back.
function runner(runChild: (params: any) => Promise<any>, roles = SUBAGENT_ROLES) {
  const parent: ParentTurn = {
    model: 'test',
    systemMessages: [{ role: ROLE.SYSTEM, content: 'You are ocode.' }],
    toolProfile: {},
    config: { maxIterations: 25, subagents: true },
    cwd: process.cwd(),
    state: { changes: [] },
    toolRunner: { run: async () => ({ result: { ok: true, kind: 'text', display: 'ok' }, timedOut: false, durationMs: 0 }) } as any,
  };
  return { delegate: createSubagentRunner(parent, runChild, roles), parent };
}
const finished = (content: string, extra: Record<string, unknown> = {}) => ({ content, stopReason: STOP_REASONS.COMPLETE, toolResults: [], iterations: 1, ...extra });

describe('the subagent runner', () => {

  it('starts the child with its role: the task alone, its instruction, its step budget, one level deep', async () => {
    let seen: any;
    const { delegate } = runner(async (params) => {
      seen = params;
      return finished('done');
    });
    const r = await delegate({ role: 'coding', task: 'Fix the bug' });
    assert.equal(r.ok, true);
    assert.equal(r.answer, 'done');
    assert.equal(seen.subagentDepth, 1);
    assert.equal(seen.config.maxIterations, SUBAGENT_ROLES.coding.maxIterations);
    assert.deepEqual(seen.history.messages.map((m: any) => m.content), ['Fix the bug']);
    assert.equal(seen.systemMessages.at(-1).content, SUBAGENT_ROLES.coding.instruction);
    for (const name of CHILD_EXCLUDED_TOOLS) assert.ok(seen.toolProfile.exclude.includes(name));
    assert.equal(seen.callbacks.onDelta, undefined, 'the child\'s answer is not streamed as the parent\'s');
  });

  it('a child that did not finish comes back as a failure, with what it got done', async () => {
    const { delegate } = runner(async () => finished('got halfway', { stopReason: STOP_REASONS.GUARD_STUCK, toolResults: [{ name: 'read_file' }], iterations: 4 }));
    const r = await delegate({ role: 'research', task: 'Find it' });
    assert.equal(r.ok, false);
    assert.equal(r.answer, 'got halfway');
    assert.equal(r.stopReason, STOP_REASONS.GUARD_STUCK);
    assert.match(r.error!, /a step was not allowed, or it made the same call three times/);
    assert.deepEqual(r.toolsUsed, ['read_file']);
    assert.equal(r.steps, 4);
  });

  it('a child that runs out of time is stopped at its role\'s limit, and only the child', async () => {
    const roles = { slow: { ...SUBAGENT_ROLES.research, id: 'slow', timeoutMs: 50 } };
    const { delegate } = runner(
      (params) => new Promise((resolve) => params.signal.addEventListener('abort', () => resolve(finished('', { stopReason: STOP_REASONS.CANCELLED })))),
      roles,
    );
    const started = Date.now();
    const r = await delegate({ role: 'slow', task: 'Never ends' });
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
    assert.equal(r.ok, false);
    assert.equal(r.stopReason, 'timed_out');
    assert.match(r.error!, /ran out of time after 0s/);
  });

  it('a child whose time runs out mid model call still comes back timed out, with the files it changed', async () => {
    const roles = { slow: { ...SUBAGENT_ROLES.coding, id: 'slow', timeoutMs: 50 } };
    const { delegate, parent } = runner(
      // The real gateway throws a cancel when its signal aborts mid call; it does not return.
      (params) => {
        parent.state.changes.push({ path: 'app.js' });
        return new Promise((_, reject) => params.signal.addEventListener('abort', () => reject(new CancelError())));
      },
      roles,
    );
    const r = await delegate({ role: 'slow', task: 'Never ends' });
    assert.equal(r.ok, false);
    assert.equal(r.stopReason, 'timed_out');
    assert.match(r.error!, /ran out of time/);
    assert.deepEqual(r.filesChanged, ['app.js']);
  });

  it('a child\'s time limit stands still while the person answers its approval, asked through the delegate call', async () => {
    const roles = { slow: { ...SUBAGENT_ROLES.coding, id: 'slow', timeoutMs: 50 } };
    const { delegate } = runner(async (params) => {
      await params.approve('exec_shell', { command: 'npm test' }, {});
      return finished('ran the tests');
    }, roles);
    const asked: string[] = [];
    const slowAnswer = async (name: string) => {
      asked.push(name);
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { allowed: true };
    };
    const r = await delegate({ role: 'slow', task: 'Run the tests' }, undefined, slowAnswer as any);
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(asked, ['exec_shell']);
  });

  it('the parent stopping stops the child, as a cancel and not a failure', async () => {
    const controller = new AbortController();
    const { delegate } = runner((params) => new Promise((resolve) => {
      params.signal.addEventListener('abort', () => resolve(finished('', { stopReason: STOP_REASONS.CANCELLED })));
      setTimeout(() => controller.abort(), 10);
    }));
    await assert.rejects(delegate({ role: 'research', task: 'Look' }, controller.signal), (err: unknown) => isCancel(err));
  });

  it(`starts at most ${MAX_DELEGATIONS_PER_TURN} children in one turn`, async () => {
    let runs = 0;
    const { delegate } = runner(async () => {
      runs += 1;
      return finished('ok');
    });
    for (let i = 0; i < MAX_DELEGATIONS_PER_TURN; i++) assert.equal((await delegate({ role: 'research', task: `task ${i}` })).ok, true);
    const over = await delegate({ role: 'research', task: 'one more' });
    assert.equal(over.ok, false);
    assert.equal(over.stopReason, 'refused');
    assert.equal(runs, MAX_DELEGATIONS_PER_TURN);
  });

  it('refuses an unknown role or an empty task without starting anything', async () => {
    let runs = 0;
    const { delegate } = runner(async () => {
      runs += 1;
      return finished('ok');
    });
    assert.match((await delegate({ role: 'wizard', task: 'x' })).error!, /no "wizard" subagent; the roles are research, review, coding, test/);
    assert.match((await delegate({ role: 'research', task: '  ' })).error!, /task is empty/);
    assert.equal(runs, 0);
  });
});

describe('roles of your own (agent.subagentRoles)', () => {
  it('adds a role with safe defaults, can replace a built-in, and skips one it cannot use', () => {
    const roles = allRoles({
      security: { summary: 'reviews for security problems', instruction: 'Look for injection, secrets and unsafe input handling.' },
      docs: { instruction: 'Update the docs to match the code.', readOnly: false, maxIterations: 30, timeoutMs: 3_600_000 },
      review: { instruction: 'Review strictly.', maxIterations: 40 },
      'Bad Name': { instruction: 'x' },
      empty: { instruction: '  ' },
    } as any);
    assert.equal(roles.security.readOnly, true, 'read-only unless it says otherwise');
    assert.equal(roles.security.maxIterations, 15);
    assert.match(roles.security.instruction, /^You are a subagent: .* Look for injection/, 'the reporting rule comes first');
    assert.equal(roles.docs.readOnly, false);
    assert.equal(roles.docs.timeoutMs, 480_000, 'held under the tool runtime\'s 10 minutes');
    assert.equal(roles.review.maxIterations, 40, 'a built-in can be replaced');
    assert.equal(roles.research.id, 'research', 'the other built-ins stay');
    assert.equal('Bad Name' in roles || 'empty' in roles, false);
  });
});
