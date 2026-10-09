// What the model is sent, and what the log keeps: each case here was a real session that went wrong.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';
import { buildModelRequest, DEFAULT_HISTORY_TOKENS } from '../src/context/builder';
import { ContextStore } from '../src/context/store';
import { createWorkspaceState, describeSession } from '../src/context/workspace-state';
import { openWorkspaceIndex } from '../src/context/workspace-index/open';
import { createAgentRuntime } from '../src/agent/runtime';
import { createAgentState } from '../src/agent/state';
import { configureLogger, logger } from '../src/core/logger';
import { ROLE } from '../src/protocol';
import { runTurn } from '../src/agent/turn/turn';
import { runCompact } from '../src/cli/commands/cmds/compact';
import { buildTurnContext } from '../src/agent/turn/context';
import '../src/tool/index';
import { gatherContext } from '../src/context/auto-context';

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
});

describe('the workspace index', () => {

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
});

describe('context-fixed-overflow', () => {
  test('instructions larger than the window fail with that reason, without compacting an empty conversation', async () => {
    const history = new ContextStore({ messages: [] });
    history.addUser('what is c#', { pinned: true });
    let compactions = 0;
    let modelCalls = 0;

    const fail = runTurn({
      model: 'tinyllama:latest',
      history,
      systemMessages: [{ role: ROLE.SYSTEM, content: 'instructions '.repeat(2000) }],
      config: { maxIterations: 3, contextWindow: 2048, maxTokens: 819 },
      toolsEnabled: false,
      gateway: {
        model: 'tinyllama:latest',
        provider: { id: 'ollama' },
        async stream() {
          modelCalls++;
          throw new Error('must not be sent');
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
      compactor: (() => {
        compactions++;
        return { capacityTokens: 0, dropped: 0 };
      }) as any,
    });

    await assert.rejects(fail, /tinyllama:latest's 2,048-token window can't hold ocode's instructions .* \/tools/);
    assert.equal(compactions, 0, 'there was nothing compaction could drop');
    assert.equal(modelCalls, 0, 'a request known not to fit is never sent');
  });
});

describe('context-notice', () => {
  // The context fills up: older history is capped, the person is told before and when it is trimmed, and /compact trims now.
  /** A conversation of n finished exchanges, each about `words` words long. */
  function conversation(n: number, words = 400): ContextStore {
    const messages: any[] = [];
    const text = (tag: string) => Array.from({ length: words }, (_, i) => `${tag}${i}`).join(' ');
    for (let i = 0; i < n; i++) messages.push({ role: ROLE.USER, content: `question ${i} ${text('q')}` }, { role: ROLE.ASSISTANT, content: `answer ${i} ${text('a')}` });
    messages.push({ role: ROLE.USER, content: 'the new question' });
    return new ContextStore({ messages });
  }

  async function request(store: ContextStore) {
    await buildModelRequest({ store, systemMessages: [{ role: ROLE.SYSTEM, content: 'You are ocode.' }], modelLimits: { contextWindow: 200_000, maxOutputTokens: 80_000 } } as any);
    return store.lastBudget!;
  }

  describe('context filling up', () => {
    it('older history is capped at the default even with a 200k window', async () => {
      const budget = await request(conversation(200));
      assert.ok(budget.historyTokens <= DEFAULT_HISTORY_TOKENS + 500, `history ${budget.historyTokens}`);
      assert.ok(budget.dropped > 0);
    });

    it('/compact summary keeps a model-written summary of what it removed', async () => {
      const store = conversation(40);
      const asked: any[] = [];
      const provider = {
        id: 'test', label: 'Test', detect: async () => true, ensureAuth: async () => {}, listModels: async () => [],
        async streamChat({ messages }: any) {
          asked.push(messages);
          return { content: '- built the parser in src/parse.js\n- tests still failing on dates', toolCalls: [], finishReason: 'stop' };
        },
      };
      const written: string[] = [];
      await runCompact({
        history: store, write: (t: string) => written.push(t), persist: () => {},
        session: { provider, model: 'm' }, cfg: { agent: { maxRetries: 0, idleTimeoutMs: 10_000, firstTokenTimeoutMs: 10_000 } }, workspace: {},
      }, 'summary');
      assert.equal(asked.length, 1);
      assert.match(asked[0][1].content, /question 39/, 'the older conversation was sent, newest kept when long');
      assert.ok(asked[0][1].content.length <= 60_000);
      assert.match(String(store.preservedSummary), /^Summary of the earlier conversation:\n- built the parser/);
      assert.match(written.join(''), /A summary of what was removed is kept/);
    });

    it('/compact keeps the latest request and cuts the rest down', async () => {
      const store = conversation(40);
      const before = store.tokenCount;
      const written: string[] = [];
      let saved = 0;
      await runCompact({ history: store, write: (t: string) => written.push(t), persist: () => { saved += 1; } });
      assert.ok(store.tokenCount < before / 4, `${before} → ${store.tokenCount}`);
      assert.equal(store.messages.at(-1)?.content, 'the new question');
      assert.match(String(store.preservedSummary), /Earlier conversation trimmed/);
      assert.equal(saved, 1);
      assert.match(written.join(''), /compacted/);
    });
  });
});

describe('system-prompt-stable', () => {
  describe('the project list the model is given', () => {
    it('is every project in the workspace, whatever the request says', async () => {
      const workspace: any = {
        cwd: '/tmp/ws',
        stacks: [
          { id: 'node', label: 'Node.js', root: '/tmp/ws/todo-app', markers: ['package.json'] },
          { id: 'dotnet', label: '.NET', root: '/tmp/ws/bid-app', markers: ['bid.sln'] },
        ],
        runtimes: {},
        contextLength: 131072,
      };
      const forRequest = async (input: string) =>
        (await buildTurnContext({ workspace, toolsEnabled: true, input, includeAutoContext: false })).system[0].content;
      const todo = await forRequest('create a todo app in node.js');
      const other = await forRequest('give me plan to implement e-hailing in node.js');
      assert.equal(todo, other, 'one request\'s words must not narrow the projects the model is told about');
      assert.match(String(todo), /bid-app/);
    });
  });
});

describe('auto-context', () => {
  test('key files go into auto-context as their own text, without line numbers', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-autoctx-'));
    try {
      fs.writeFileSync(path.join(cwd, 'package.json'), '{\n  "name": "demo",\n  "scripts": { "test": "node --test" }\n}\n');
      const block = await gatherContext(cwd, { projectDoc: null });
      assert.match(block, /package\.json:\n\{\n {2}"name": "demo",/);
      assert.doesNotMatch(block, /^\s+\d+\t/m, 'no line-number gutter');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
