// Fixes from the code review of the review/codebase-review branch; each case is the failure the review found.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ContextStore } from '../src/context/store';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentRuntime } from '../src/agent/runtime';
import { createAgentState } from '../src/agent/state';
import askUser from '../src/tool/agent/interaction/ask-user.tool';
import todoWrite, { taskTodos } from '../src/agent/planning/todo-write.tool';
import { renderMath } from '../src/ui/latex';
import { runTurn } from '../src/agent/turn/turn';
import { STOP_REASONS } from '../src/protocol';
import { BackgroundInbox } from '../src/tool/process/background-inbox';
import { lineageOf, listProcesses } from '../src/tool/process/processes/discovery';
import { markStoppedByAgent } from '../src/tool/process/subprocess-state';
import { namesKilledBy, ownProcessStoppedBy } from '../src/tool/process/analysis/own-process';
import execShell from '../src/tool/process/exec-shell.tool';

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: args } });

const never = async () => { throw new Error('not used'); };
const STUB_PROVIDER = { id: 'test', label: 'test', detect: never, ensureAuth: never, listModels: never, streamChat: never };

type Reply = { content?: string; toolCalls?: unknown[]; finishReason?: string };

/** A runtime whose model plays back `replies` in order, and whose tools are `run`. */
function scripted(replies: Reply[], run: (name: string, args: any, state: any) => Promise<unknown>) {
  const cwd = tmp('ocode-review-');
  const workspace: any = { cwd, state: createWorkspaceState(cwd), runtimes: {}, stacks: [] };
  const runtime: any = createAgentRuntime({
    provider: STUB_PROVIDER, model: 'test', config: { maxIterations: 4 }, checkpoints: false,
    workspace, history: new ContextStore({ messages: [], budgetTokens: 8000 }), agentState: createAgentState(),
  });
  let asked = 0;
  runtime.gateway = {
    model: 'test',
    provider: { id: 'test' },
    async stream() {
      const next = replies[asked++] ?? { content: 'Done.' };
      return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: next.finishReason ?? 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
    },
  };
  const toolRunner = { async run(name: string, args: any) { return { result: await run(name, args, workspace.state) }; } };
  return { runtime, workspace, toolRunner, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

describe('ask_user', () => {
  it('can ask again in a later turn: the one-question allowance is per turn, not per session', async () => {
    const questions: string[] = [];
    const ask = async (q: string) => { questions.push(q); return 'yes'; };
    const t = scripted(
      [
        { toolCalls: [call('1', 'ask_user', { question: 'Use xUnit?' })] },
        { content: 'Using xUnit.' },
        { toolCalls: [call('2', 'ask_user', { question: 'Add coverage too?' })] },
        { content: 'Adding coverage.' },
      ],
      (_name, args, state) => askUser.execute(args, { state, ask } as any),
    );
    try {
      await t.runtime.execute({ input: 'add tests', toolRunner: t.toolRunner, includeAutoContext: false });
      await t.runtime.execute({ input: 'and coverage?', toolRunner: t.toolRunner, includeAutoContext: false });
      assert.deepEqual(questions, ['Use xUnit?', 'Add coverage too?'], 'the second turn\'s question reached the person');
    } finally {
      t.cleanup();
    }
  });
});

describe('a turn that uses up its steps', () => {
  it("ends with the model's account of what it did, not an empty answer", async () => {
    let n = 0;
    const result = await runTurn({
      model: 'test',
      history: new ContextStore({ messages: [{ role: 'user', content: 'refactor everything' }], budgetTokens: 8000 }),
      config: { maxIterations: 2 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream(request: any) {
          n += 1;
          // The closing request offers no tools and gets the account.
          if (!request.tools?.length) return { result: { content: 'Read a.ts and b.ts; the refactor is not done yet.', toolCalls: [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
          return { result: { content: '', toolCalls: [call(`c${n}`, 'read_file', { path: `${n}.ts` })], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run() { return { result: { ok: true, kind: 'text', display: 'data' } }; } } as any,
    } as any);
    assert.equal(result.stopReason, STOP_REASONS.MAX_ITERATIONS);
    assert.equal(result.content, 'Read a.ts and b.ts; the refactor is not done yet.');
  });
});

describe('ended background jobs', () => {
  const exit = (id: string, endedAt: number) => ({
    id, command: `build ${id}`, outcome: 'finished' as const, exitCode: 0, signal: null, durationMs: 1000, tail: 'Build succeeded.', endedAt,
  });

  it('keeps one that ended in the same millisecond as the request that showed the others', () => {
    const inbox = new BackgroundInbox();
    const now = Date.now();
    inbox.record(exit('shown', now));
    inbox.markShown();
    inbox.record(exit('same-ms', now));
    inbox.settle();
    assert.deepEqual(inbox.pending().map((e) => e.id), ['same-ms']);
  });

  it('are still pending after a turn whose model call failed, so the model is told next time', async () => {
    const t = scripted([], async () => ({ ok: true }));
    t.runtime.gateway.stream = async () => { throw new Error('ollama went away'); };
    t.workspace.state.background.record(exit('docker-build', Date.now() - 1000));
    try {
      await assert.rejects(t.runtime.execute({ input: 'hello', toolRunner: t.toolRunner, includeAutoContext: false }));
      assert.deepEqual(t.workspace.state.background.pending().map((e: any) => e.id), ['docker-build']);
    } finally {
      t.cleanup();
    }
  });
});

describe('an answer cut off at the length limit', () => {
  it('keeps its text and can be continued', async () => {
    const t = scripted([{ content: 'Step 1: create the project. Step 2: add the', finishReason: 'length' }], async () => ({ ok: true }));
    try {
      const result = await t.runtime.execute({ input: 'explain the setup', toolRunner: t.toolRunner, includeAutoContext: false });
      assert.equal(result.stopReason, STOP_REASONS.OUTPUT_TRUNCATED);
      assert.equal(result.content, 'Step 1: create the project. Step 2: add the');
      assert.equal(t.workspace.state.pendingOutputContinuation, true, '/continue picks it up');
    } finally {
      t.cleanup();
    }
  });
});

describe('stop_process on one of ocode\'s own background jobs', () => {
  it('reads each process\'s parent from the OS', async () => {
    const own = (await listProcesses()).find((p) => p.pid === process.pid);
    assert.ok(own, 'this process is listed');
    assert.equal(own.parentPid, process.ppid);
  });

  it('marks the job stopped on purpose when what is killed is the job or runs under it', () => {
    // shell (20) → npm (30) → node holding the port (40)
    const processes = [{ pid: 40, parentPid: 30 }, { pid: 30, parentPid: 20 }, { pid: 20, parentPid: 1 }] as any[];
    assert.deepEqual([...lineageOf(40, processes)], [40, 30, 20, 1]);
    const devServer: any = { process: { pid: 20 } };
    const other: any = { process: { pid: 99 } };
    markStoppedByAgent(new Map([['dev', devServer], ['other', other]]), [lineageOf(40, processes)]);
    assert.equal(devServer.stopRequested, true, 'its end is not reported as a crash');
    assert.equal(other.stopRequested, undefined, 'an unrelated job is still reported when it ends');
  });
});

describe('the pinned task list', () => {
  it('is drawn for the new task when a turn starts, not the previous task\'s', async () => {
    const t = scripted(
      [
        { toolCalls: [call('1', 'todo_write', { todos: [{ content: 'Write the parser', status: 'pending' }] })] },
        { content: 'Started.' },
        { content: 'Hello.' },
      ],
      (_name, args, state) => todoWrite.execute(args, { state } as any),
    );
    try {
      await t.runtime.execute({ input: 'write the parser', toolRunner: t.toolRunner, includeAutoContext: false });
      const seenAtStart: unknown[][] = [];
      await t.runtime.execute({
        input: 'say hello', toolRunner: t.toolRunner, includeAutoContext: false,
        onTaskStart: () => seenAtStart.push(taskTodos(t.workspace.state)),
      });
      assert.deepEqual(seenAtStart, [[]], 'the chat draws the list when told the task started');
    } finally {
      t.cleanup();
    }
  });
});

describe('math in answers', () => {
  it('shows \\bmod as mod', () => {
    assert.equal(renderMath(String.raw`a \bmod n`), 'a mod n');
  });
});

describe('a command that would stop ocode itself', () => {
  it('reads which programs a command stops by name', () => {
    assert.deepEqual(namesKilledBy('Start-Process node app.js\nStart-Sleep 2\nStop-Process -Name node -Force'), ['node']);
    assert.deepEqual(namesKilledBy('taskkill /F /IM node.exe'), ['node']);
    assert.deepEqual(namesKilledBy('Get-Process node | Stop-Process'), ['node']);
    assert.deepEqual(namesKilledBy('pkill -f node'), ['node']);
    assert.deepEqual(namesKilledBy('Stop-Process -Name nginx,redis'), ['nginx', 'redis']);
    assert.deepEqual(namesKilledBy('Stop-Process -Id 1234'), [], 'by pid it stops only that process');
    assert.deepEqual(namesKilledBy('node app.js'), []);
  });

  it('knows ocode runs as node and under its parent, and leaves other programs alone', async () => {
    const self = await ownProcessStoppedBy('Stop-Process -Name node -Force');
    assert.equal(self?.pid, process.pid);
    assert.equal(await ownProcessStoppedBy('Stop-Process -Name nginx-not-running'), null);
    const above = lineageOf(process.pid, await listProcesses());
    assert.ok(above.has(process.ppid), 'the process ocode runs under is in its lineage, so stop_process refuses it');
  });

  it('is refused by exec_shell before it runs', async () => {
    const cwd = tmp('ocode-selfkill-');
    try {
      // A dry run on purpose: if the refusal ever broke, this still stops nothing.
      const command = process.platform === 'win32' ? 'Stop-Process -Name node -WhatIf' : 'pkill -0 node';
      const result: any = await execShell.execute({ command }, { cwd, root: cwd, state: createWorkspaceState(cwd) } as any);
      assert.equal(result.ok, false);
      assert.equal(result.code, 'EDENIED');
      assert.match(result.error, /would end this session/);
      assert.match(result.hint, /stop_subprocess/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
