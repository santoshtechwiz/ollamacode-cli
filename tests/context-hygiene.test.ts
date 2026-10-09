// What the model is sent, and what the log keeps: each case here was a real session that went wrong.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { buildModelRequest } from '../src/context/builder';
import { ContextStore } from '../src/context/store';
import { createWorkspaceState, describeSession } from '../src/context/workspace-state';
import { buildSystemPrompt } from '../src/prompts/system';
import { outputDirsAt } from '../src/env/project-layout';
import { openWorkspaceIndex } from '../src/context/workspace-index/open';
import { createAgentRuntime } from '../src/agent/runtime';
import { createAgentState } from '../src/agent/state';
import { configureLogger, logger } from '../src/core/logger';
import { traceRequestBody } from '../src/model/gateway';
import { traceStreamEvent } from '../src/model/stream-events';
import { ROLE } from '../src/protocol';

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: args } });
const assistantCall = (id: string, name: string, args: Record<string, unknown>) => ({ role: ROLE.ASSISTANT, content: '', tool_calls: [call(id, name, args)] });
const toolResult = (id: string, name: string, content: string) => ({ role: ROLE.TOOL, content, tool_call_id: id, name });
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A session with one finished turn and the current one partway through. */
function twoTurns(): ContextStore {
  const store: any = new ContextStore({ messages: [], budgetTokens: 8000 });
  store.addUser('build the app');
  store.messages.push(assistantCall('a', 'write_file', { path: 'A.cs', content: 'x'.repeat(3000) }));
  store.messages.push(toolResult('a', 'write_file', 'OK write_file — Created A.cs\n' + '+ line\n'.repeat(200)));
  store.addAssistant('Built.');
  store.addUser('run the unit test');
  store.messages.push(assistantCall('b', 'exec_shell', { command: 'dotnet test', note: 'y'.repeat(500) }));
  store.messages.push(toolResult('b', 'exec_shell', 'OK exec_shell — $ dotnet test\nPassed! 36 tests'));
  return store;
}

describe('the request the model is sent', () => {
  it('keeps the person\'s request where it was asked, before this turn\'s tool calls and results', async () => {
    const { messages } = await buildModelRequest({ store: twoTurns(), includeWorkspaceSnapshot: false });
    const request = messages.findIndex((m) => m.role === ROLE.USER && m.content === 'run the unit test');
    const result = messages.findIndex((m) => m.role === ROLE.TOOL && String(m.content).includes('Passed!'));
    assert.ok(request >= 0 && result >= 0);
    assert.ok(request < result, 'moved after the result, the request reads as asked again and the work is redone');
    assert.equal(messages.at(-1)?.role, ROLE.TOOL, 'the newest thing the model reads is its own result');
  });

  it('sends an earlier turn\'s tool output as its first line only, and this turn\'s whole', async () => {
    const { messages } = await buildModelRequest({ store: twoTurns(), includeWorkspaceSnapshot: false });
    const results = messages.filter((m) => m.role === ROLE.TOOL).map((m) => String(m.content));
    assert.equal(results[0], 'OK write_file — Created A.cs\n[output from an earlier request omitted]');
    assert.equal(results[1], 'OK exec_shell — $ dotnet test\nPassed! 36 tests');
  });

  it('cuts long arguments of an earlier turn\'s calls, and keeps this turn\'s calls whole', async () => {
    const { messages } = await buildModelRequest({ store: twoTurns(), includeWorkspaceSnapshot: false });
    const [earlier, current] = messages.filter((m) => m.tool_calls?.length).map((m) => m.tool_calls![0].function.arguments as any);
    assert.equal(earlier.path, 'A.cs', 'what the call was about stays');
    assert.match(earlier.content, /^x{80}… \[2920 more chars omitted\]$/);
    assert.equal(current.note.length, 500, 'the current turn is sent as it is');
  });

  it('after "continue", the turn it continues is sent whole, so its reads are not redone', async () => {
    const store: any = new ContextStore({ messages: [], budgetTokens: 8000 });
    store.addUser('build the app');
    store.messages.push(assistantCall('a', 'read_file', { path: 'server.js' }));
    store.messages.push(toolResult('a', 'read_file', 'OK read_file — server.js\n' + 'const app = express();\n'.repeat(50)));
    store.addAssistant('Stopped here.');
    store.addUser('continue');
    const { messages } = await buildModelRequest({ store, includeWorkspaceSnapshot: false });
    const read = messages.find((m) => m.role === ROLE.TOOL);
    assert.match(String(read?.content), /const app = express\(\);/, 'the file the stopped turn read is still there');
    assert.doesNotMatch(String(read?.content), /earlier request omitted/);
  });

  it('leaves the saved conversation untouched', async () => {
    const store = twoTurns();
    await buildModelRequest({ store, includeWorkspaceSnapshot: false });
    assert.equal((store.messages[1] as any).tool_calls[0].function.arguments.content.length, 3000);
    assert.ok(String(store.messages[2].content).length > 1000);
  });
});

describe('the environment the system prompt describes', () => {
  const rt = (name: string) => ({ name, available: true, version: '1.0.0' });
  const runtimes = { dotnet: rt('dotnet'), terraform: rt('terraform'), node: rt('node'), python: rt('python'), git: rt('git') };
  const dotnet = { id: 'dotnet', label: 'C# / .NET', root: 'c:/w', marker: 'App.csproj', test: ['dotnet', 'test'] };

  it('lists the toolchains of the workspace\'s projects and git, not everything installed', () => {
    const prompt = buildSystemPrompt({ cwd: 'c:/w', stacks: [dotnet], runtimes });
    assert.match(prompt, /Available runtimes: dotnet \(1\.0\.0\), git \(1\.0\.0\)/);
    assert.doesNotMatch(prompt, /terraform|python|node \(/i);
    assert.doesNotMatch(prompt, /Common commands/);
    assert.match(prompt, /test: dotnet test/, 'the project\'s own commands are listed instead');
  });

  it('lists everything installed when the workspace has no project yet', () => {
    const prompt = buildSystemPrompt({ cwd: 'c:/w', stacks: [], runtimes });
    assert.match(prompt, /terraform \(1\.0\.0\)/);
  });
});

describe('the workspace index', () => {
  it('names a .NET project\'s build output folders, and none for a project without any', () => {
    const dotnet = tmp('ocode-dotnet-');
    const node = tmp('ocode-node-');
    try {
      fs.writeFileSync(path.join(dotnet, 'App.csproj'), '<Project />');
      fs.writeFileSync(path.join(node, 'package.json'), '{}');
      assert.deepEqual(outputDirsAt(dotnet), [path.join(dotnet, 'bin'), path.join(dotnet, 'obj')]);
      assert.deepEqual(outputDirsAt(node), [], 'a node project\'s bin/ holds its own scripts');
    } finally {
      fs.rmSync(dotnet, { recursive: true, force: true });
      fs.rmSync(node, { recursive: true, force: true });
    }
  });

  it('does not index what a .NET build wrote', async () => {
    const root = tmp('ocode-index-');
    fs.writeFileSync(path.join(root, 'App.csproj'), '<Project Sdk="Microsoft.NET.Sdk" />');
    fs.writeFileSync(path.join(root, 'Program.cs'), 'class Program {}');
    fs.mkdirSync(path.join(root, 'bin', 'Debug'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bin', 'Debug', 'App.deps.json'), '{}');
    const index: any = await openWorkspaceIndex(root);
    try {
      assert.ok(index, 'the index opened');
      const files = index.db.prepare('SELECT rel_path FROM files').all().map((r: any) => String(r.rel_path).replace(/\\/g, '/'));
      assert.ok(files.includes('Program.cs'));
      assert.ok(!files.some((f: string) => f.startsWith('bin/')), `indexed: ${files.join(', ')}`);
    } finally {
      await index?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the session record', () => {
  it('lists only the calls made for this request; a new request starts with none', () => {
    const state: any = createWorkspaceState(tmp('ocode-record-'));
    state.taskId = 't1';
    state.record({ name: 'exec_shell', summary: 'run: dotnet build', ok: true });
    state.taskId = 't2';
    state.record({ name: 'read_file', summary: 'read file A.cs', ok: true });
    const record = describeSession(state);
    assert.match(record, /Tool calls actually executed for this request:\n- read file A\.cs → ok/);
    assert.doesNotMatch(record, /dotnet build/, 'an earlier request\'s call read as this one\'s work');
    state.taskId = 't3';
    assert.equal(describeSession(state), '');
  });
});

describe('resuming an interrupted task', () => {
  const never = async () => { throw new Error('not used'); };
  const STUB_PROVIDER = { id: 'test', label: 'test', detect: never, ensureAuth: never, listModels: never, streamChat: never };

  /** A runtime holding a resumable checkpoint, and every message the model was sent. */
  function interrupted() {
    const cwd = tmp('ocode-resume-');
    const workspace: any = { cwd, state: createWorkspaceState(cwd), runtimes: {}, stacks: [] };
    const runtime: any = createAgentRuntime({
      provider: STUB_PROVIDER, model: 'test', config: { maxIterations: 2 }, checkpoints: false,
      workspace, history: new ContextStore({ messages: [], budgetTokens: 8000 }), agentState: createAgentState(),
    });
    runtime.checkpoint = { resumable: true, task: 'build the app', completed: [{ tool: 'exec_shell', target: 'dotnet build', ok: true, at: 1 }] };
    const sent: string[] = [];
    runtime.gateway = {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        sent.push(...request.messages.map((m: any) => String(m.content)));
        return { result: { content: 'Done.', toolCalls: [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
      },
    };
    const toolRunner = { async run() { throw new Error('no tools here'); } };
    return { runtime, sent, toolRunner, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
  }

  it('does not tell a new, unrelated request that it is resuming', async () => {
    const t = interrupted();
    try {
      await t.runtime.execute({ input: 'why did you build three times', toolRunner: t.toolRunner, includeAutoContext: false });
      assert.ok(!t.sent.some((m) => m.includes('RESUMING AN INTERRUPTED TASK')));
    } finally {
      t.cleanup();
    }
  });

  it('gives the completed steps when the person continues', async () => {
    const t = interrupted();
    try {
      await t.runtime.execute({ input: 'continue', continuing: true, toolRunner: t.toolRunner, includeAutoContext: false });
      assert.ok(t.sent.some((m) => m.includes('RESUMING AN INTERRUPTED TASK') && m.includes('dotnet build')));
    } finally {
      t.cleanup();
    }
  });
});

describe('the debug log', () => {
  /** Log at `level` to a fresh file for the duration of `body`, and return what was written. */
  function logged(level: 'debug' | 'trace', body: () => void): string {
    const home = tmp('ocode-log-');
    const before = logger;
    try {
      configureLogger({ level, toFile: true, homeDir: home });
      body();
      const dir = path.join(home, 'logs');
      return fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('');
    } finally {
      // The logger keeps its file open; Windows will not remove an open file.
      const fd = (logger as any)._fd;
      if (fd != null) fs.closeSync(fd);
      configureLogger({ level: before.level });
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  it('masks secrets, and leaves code that only mentions a token readable', () => {
    const text = logged('debug', () => {
      logger.debug('Task<int> CountAsync(CancellationToken cancellationToken = default);');
      logger.debug('"token": "abcd1234efgh5678"');
      logger.debug('api_key=sk_live_ABCDEFGH12');
    });
    assert.match(text, /cancellationToken = default\);/);
    assert.match(text, /"token": "\*\*\*"/);
    assert.match(text, /api_key=\*\*\*/);
    assert.doesNotMatch(text, /abcd1234efgh5678|sk_live_ABCDEFGH12/);
  });

  it('logs a reply\'s usage and finish, not a line per streamed chunk', () => {
    const text = logged('trace', () => {
      for (let i = 0; i < 50; i++) traceStreamEvent('Ollama', { type: 'assistant', delta: 'x' });
      traceStreamEvent('Ollama', { type: 'tool_call_delta', argsText: '{}' });
      traceStreamEvent('Ollama', { type: 'usage', promptTokens: 10, completionTokens: 2 });
      traceStreamEvent('Ollama', { type: 'finish', reason: 'stop' });
    });
    assert.doesNotMatch(text, /assistant \+1ch|tool_call_delta/);
    assert.match(text, /usage prompt=10 completion=2/);
    assert.match(text, /finish stop/);
  });

  it('logs only what changed since the previous request, not the whole conversation and every tool again', () => {
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file.' } }];
    const first = [{ role: 'system', content: 'SYSTEM-PROMPT' }, { role: 'user', content: 'run the unit test' }];
    const second = [...first, { role: 'tool', content: 'NEW-RESULT' }];
    const text = logged('trace', () => {
      traceRequestBody(first, tools);
      traceRequestBody(second, tools);
    });
    assert.equal(text.split('SYSTEM-PROMPT').length - 1, 1, 'the unchanged system prompt is logged once');
    assert.match(text, /<messages 0-1: same as the previous request>/);
    assert.match(text, /NEW-RESULT/);
    assert.equal(text.split('Read a file.').length - 1, 1, 'unchanged tool schemas are logged once');
    assert.match(text, /<same 1 tool\(s\) as the previous request>/);
  });
});
