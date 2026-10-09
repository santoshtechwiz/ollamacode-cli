import assert from 'node:assert/strict';
import { describe, it, after, before } from 'node:test';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore, createContextStore } from '../src/context/store';
import { STOP_REASONS, ROLE, TOOL_ERROR_CODE } from '../src/protocol';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type TurnState } from '../src/agent/turn/turn-state';
import { type ContextStore as ContextStoreContract } from '../src/context/contracts';
import { resolveScope } from '../src/agent/workspace/scope';
import { type ToolCall, type ToolResult } from '../src/types';

type Reply = { content?: string; toolCalls?: any[]; finishReason?: string };

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, type: 'function', function: { name, arguments: args } });

// A scripted model and a tool runner that counts file changes like the real runtime; arguments still go through the real prepare step.
async function turn(replies: Reply[]) {
  const requests: any[] = [];
  const state: any = { mutationCount: 0 };
  const ran: string[] = [];
  const history = new ContextStore({ messages: [{ role: ROLE.USER, content: 'do the task' }], budgetTokens: 8000 });
  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 12 },
    toolsEnabled: true,
    toolsAllowed: true,
    state,
    toolProfile: { always: ['read_file', 'write_file', 'edit_file', 'exec_shell'] },
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        requests.push(request);
        const next = replies[requests.length - 1] ?? { content: '' };
        return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: next.finishReason ?? 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
      },
    } as any,
    toolRunner: {
      async run(name: string) {
        ran.push(name);
        if (name === 'write_file' || name === 'edit_file') state.mutationCount += 1;
        if (name === 'exec_shell') return { result: { ok: true, kind: 'command', display: 'tests pass' } };
        return { result: { ok: true, kind: 'text', display: 'ok' } };
      },
    } as any,
  } as any);
  const users = history.messages.filter((m) => m.role === ROLE.USER).map((m) => m.content);
  return { requests, ran, result, users };
}

describe('turn flow', () => {
  it('a reply cut off while writing a tool call out as text is not kept as the answer', async () => {
    for (const half of ['<tool_call>\n<function=edit_file>\n<parameter=path>\nmain.go', '{"name": "edit_file", "arguments": {"path": "main.go", "edits": [{"search": "pack']) {
      const t = await turn([{ content: half, finishReason: 'length' }]);
      assert.equal(t.result.stopReason, STOP_REASONS.OUTPUT_TRUNCATED);
      assert.equal(t.result.content, '', `kept: ${half.slice(0, 30)}`);
    }
  });

  it('keeps what a reply said alongside its tool calls, once, so the next request carries it', async () => {
    const plan = 'Here is the plan: 1) parse flags 2) send the request.';
    const t = await turn([
      { content: `${plan}\n{"name": "read_file", "arguments": {"path": "a.go"}}`, toolCalls: [call('1', 'read_file', { path: 'a.go' }), call('2', 'read_file', { path: 'b.go' })] },
      { content: 'Done.' },
    ]);
    const said = t.requests[1].messages.filter((m: any) => m.role === ROLE.ASSISTANT && m.tool_calls?.length).map((m: any) => m.content);
    assert.deepEqual(said, [plan, ''], 'the prose once, on the first call; the line that only spells out a call is dropped');
    assert.equal(t.result.content, 'Done.', 'text beside tool calls is still not the answer');
  });

  it('ends on the first text reply after work, with no hidden follow-up question', async () => {
    const t = await turn([
      { toolCalls: [call('1', 'write_file', { path: 'main_test.go', content: 'package main' })] },
      { content: 'I added main_test.go.' },
      { content: 'I have already added main_test.go.' },
    ]);
    assert.equal(t.requests.length, 2, 'a closing answer is final: nothing asks the model again');
    assert.deepEqual(t.ran, ['write_file']);
    assert.equal(t.result.content, 'I added main_test.go.');
    assert.equal(t.result.stopReason, STOP_REASONS.COMPLETE);
    assert.deepEqual(t.users, ['do the task'], 'the turn injected no message of its own');
  });

  it('lets the model fix a refused edit after a change instead of stopping the turn', async () => {
    const t = await turn([
      { toolCalls: [call('1', 'write_file', { path: 'a.cs', content: 'DisplayAlert()' })] },
      { toolCalls: [call('2', 'edit_file', { path: 'a.cs', replace: 'DisplayAlertAsync()' })] },
      { toolCalls: [call('3', 'edit_file', { path: 'a.cs', search: 'DisplayAlert()', replace: 'DisplayAlertAsync()' })] },
      { content: 'Renamed DisplayAlert to DisplayAlertAsync.' },
    ]);
    assert.deepEqual(t.ran, ['write_file', 'edit_file'], 'the refused edit never ran; the corrected one did');
    assert.equal(t.result.stopReason, STOP_REASONS.COMPLETE);
    assert.equal(t.result.content, 'Renamed DisplayAlert to DisplayAlertAsync.');
  });

  it('still stops a model that resends the exact call it was refused for', async () => {
    const bad = { path: 'a.cs', replace: 'y' };
    const t = await turn([
      { toolCalls: [call('1', 'edit_file', bad)] },
      { toolCalls: [call('2', 'edit_file', bad)] },
      { toolCalls: [call('3', 'edit_file', bad)] },
      { content: 'Gave up.' },
    ]);
    assert.deepEqual(t.ran, [], 'a refused call is never run');
    assert.equal(t.result.stopReason, STOP_REASONS.GUARD_STUCK);
    assert.ok(t.requests.length <= 3, `the identical retry ended the turn (asked ${t.requests.length} times)`);
  });

  it('keeps working after a passing test run while the model still has steps to do', async () => {
    const t = await turn([
      { toolCalls: [call('1', 'write_file', { path: 'cart.js', content: 'a' })] },
      { toolCalls: [call('2', 'exec_shell', { command: 'npm test' })] },
      { toolCalls: [call('3', 'write_file', { path: 'inventory.test.js', content: 'b' })] },
      { toolCalls: [call('4', 'exec_shell', { command: 'npm test -- inventory' })] },
      { content: 'Added the methods and their tests; all pass.' },
    ]);
    assert.deepEqual(t.ran, ['write_file', 'exec_shell', 'write_file', 'exec_shell']);
    assert.equal(t.result.content, 'Added the methods and their tests; all pass.');
    assert.equal(t.result.stopReason, STOP_REASONS.COMPLETE);
  });

  it('ends a turn whose reply is empty instead of nudging the model', async () => {
    const t = await turn([
      { toolCalls: [call('1', 'read_file', { path: 'a.cs' })] },
      { content: '' },
    ]);
    assert.equal(t.requests.length, 2);
    assert.deepEqual(t.users, ['do the task']);
  });

  it('ends a turn the decider stopped mid-reply there too, without another request', async () => {
    const t = await turn([
      { toolCalls: [call('1', 'read_file', { path: 'a.cs' })] },
      { toolCalls: [call('1', 'read_file', { path: 'b.cs' })] },
      { content: 'Read a.cs; the read of b.cs could not run.' },
    ]);
    assert.deepEqual(t.ran, ['read_file'], 'a reused call id with new arguments is never run');
    assert.equal(t.result.stopReason, STOP_REASONS.GUARD_STUCK);
    assert.equal(t.requests.length, 2);
    assert.equal(t.result.content, '');
  });

  it('lets the model carry on after a tool reports that the person stopped it', async () => {
    const ran: string[] = [];
    let asked = 0;
    const replies: Reply[] = [
      { toolCalls: [call('1', 'exec_shell', { command: 'npm run slow' }), call('2', 'read_file', { path: 'a.cs' })] },
      { content: 'The slow job was stopped, so I read a.cs instead.' },
    ];
    const result = await runTurn({
      model: 'test',
      history: new ContextStore({ messages: [{ role: ROLE.USER, content: 'do the task' }], budgetTokens: 8000 }),
      config: { maxIterations: 6 },
      state: { mutationCount: 0 },
      toolProfile: { always: ['exec_shell', 'read_file'] },
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          const next = replies[asked++] ?? { content: '' };
          return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: {
        async run(name: string) {
          ran.push(name);
          // The tool's own outcome: the person chose not to wait. It tells the model what to do next.
          if (name === 'exec_shell') return { result: { ok: false, kind: 'text', error: 'stopped by the user after 2 min', code: TOOL_ERROR_CODE.ECANCELLED, hint: 'take a faster route' } };
          return { result: { ok: true, kind: 'text', display: 'ok' } };
        },
      } as any,
    } as any);
    assert.deepEqual(ran, ['exec_shell', 'read_file'], 'the rest of the reply runs: only the person cancelling the turn stops it');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    assert.equal(result.content, 'The slow job was stopped, so I read a.cs instead.');
  });

  it('asks again without reasoning as the same step, even on the last one', async () => {
    let asked = 0;
    const result = await runTurn({
      model: 'test',
      history: new ContextStore({ messages: [{ role: ROLE.USER, content: 'do the task' }], budgetTokens: 8000 }),
      config: { maxIterations: 1 },
      state: { mutationCount: 0 },
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream(request: any) {
          asked++;
          const reply = asked === 1
            ? { content: '', reasoning: 'thinking '.repeat(50), toolCalls: [], finishReason: 'length' }
            : { content: 'Here is the answer.', toolCalls: [], finishReason: 'stop' };
          if (asked === 2) assert.equal(request.think, false, 'the second ask turns reasoning off');
          return { result: reply, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
    } as any);
    assert.equal(asked, 2);
    assert.equal(result.iterations, 1, 'the retry did not use up a step');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    assert.equal(result.content, 'Here is the answer.');
  });
});

describe('regression', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));

  type MockAnswer = {
    content?: string;
    toolCalls?: ToolCall[];
    reasoning?: string;
    finishReason?: string;
  };

  type ToolRun = {
    name: string;
    args: Record<string, unknown>;
  };

  type ToolRunner = {
    run(
      name: string,
      args: Record<string, unknown>,
    ): Promise<{
      result: ToolResult;
      timedOut: boolean;
      durationMs: number;
    }>;
  };

  type MockGateway = {
    model: string;
    provider: {
      id: string;
    };
    stream(input: {
      tools?: unknown;
      signal?: AbortSignal;
    }): Promise<{
      result: {
        content: string;
        toolCalls: ToolCall[];
        reasoning?: string;
        finishReason: string;
      };
      attempt: number;
      retries: number;
      startedAt: number;
    }>;
  };

  function createMockGateway(answers: MockAnswer[]): MockGateway & {
    getCallCount(): number;
  } {
    let callCount = 0;

    return {
      model: 'test-model',
      provider: {
        id: 'test',
      },

      getCallCount() {
        return callCount;
      },

      async stream() {
        const answer =
          answers[callCount] ??
          {
            content: '',
            toolCalls: [],
            finishReason: 'stop',
          };

        callCount++;

        return {
          result: {
            content: answer.content ?? '',
            toolCalls: answer.toolCalls ?? [],
            reasoning: answer.reasoning,
            finishReason: answer.finishReason ?? 'stop',
          },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    };
  }

  function createMockToolRunner(
    results: Map<string, ToolResult>,
  ): ToolRunner & {
    calls: ToolRun[];
  } {
    const calls: ToolRun[] = [];

    return {
      calls,

      async run(
        name: string,
        args: Record<string, unknown>,
      ) {
        calls.push({
          name,
          args,
        });

        const key = `${name}:${JSON.stringify(args)}`;
        const result = results.get(key);

        return {
          result:
            result ??
            {
              ok: true,
              kind: 'text',
              data: {
                content: `ok: ${name}`,
              },
            },
          timedOut: false,
          durationMs: 10,
        };
      },
    };
  }

  function createTestWorkspace(tmpDir: string) {
    return {
      cwd: tmpDir,
      nativeTools: true,
      contextWindow: 8000,
      contextLength: 8000,

      state: {
        mutationCount: 0,
        permissions: {
          denied: false,
        },
        sessionId: 'test-session',
      },

      index: {
        db: null,
        stamp: () => '',
        gitTracked: false,
      },

      stacks: [],
      runtimes: [],
    };
  }

  function createCall(
    id: string,
    name: string,
    args: Record<string, unknown>,
  ): ToolCall {
    return {
      id,
      type: 'function',
      function: {
        name,
        arguments: args,
      },
    };
  }

  function createResult(
    ok: boolean,
    data?: Record<string, unknown>,
    code?: string,
  ): ToolResult {
    return {
      ok,
      kind: 'text',
      ...(data ? { data } : {}),
      ...(code ? { code } : {}),
    };
  }

  function createState(
    toolCalls: TurnState['toolCalls'] = [],
  ): TurnState {
    return {
      iteration: 1,
      maxIterations: 10,
      toolCalls,
      answer: undefined,
      stopReason: undefined,
    };
  }

  describe('Agent turn regression suite', () => {
    let tmpDir: string;

    before(() => {
      tmpDir = fs.mkdtempSync(
        path.join(__dirname, '..', 'regression-test-'),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify(
          {
            name: 'test-project',
            scripts: {
              test: 'echo pass',
            },
          },
          null,
          2,
        ),
      );

      fs.mkdirSync(
        path.join(tmpDir, 'src'),
        {
          recursive: true,
        },
      );

      fs.writeFileSync(
        path.join(tmpDir, 'src.ts'),
        'export const x = 1;\n',
      );

      fs.writeFileSync(
        path.join(tmpDir, 'src', 'a.ts'),
        'export const a = 1;\n',
      );
    });

    after(() => {
      fs.rmSync(tmpDir, {
        recursive: true,
        force: true,
      });
    });

    describe('runTurn', () => {
      it('recovers from an output limit and continues the turn', async () => {
        const gateway = createMockGateway([
          {
            content: '',
            toolCalls: [
              createCall(
                '1',
                'read_file',
                {
                  path: 'src.ts',
                },
              ),
            ],
            finishReason: 'length',
            reasoning: 'long reasoning',
          },
          {
            content: 'Done',
            toolCalls: [],
            finishReason: 'stop',
          },
        ]);

        const toolRunner =
          createMockToolRunner(
            new Map(),
          );

        const history =
          createContextStore();

        const workspace =
          createTestWorkspace(tmpDir);

        const turn = await runTurn({
          model: 'test',
          history,
          gateway,
          toolRunner,
          workspace,
          config: {
            maxIterations: 5,
            maxTokens: 100,
          },
          signal: new AbortController().signal,
        });

        assert.equal(
          turn.stopReason,
          STOP_REASONS.COMPLETE,
        );

        assert.equal(
          turn.content.trim(),
          'Done',
        );

        assert.equal(
          turn.iterations,
          2,
        );

        assert.equal(
          gateway.getCallCount(),
          2,
        );
      });

      it('does not create duplicate assistant messages for a reused call', async () => {
        const gateway =
          createMockGateway([
            {
              content: '',
              toolCalls: [
                createCall(
                  '1',
                  'read_file',
                  {
                    path: 'src.ts',
                  },
                ),
              ],
              finishReason: 'stop',
            },
            {
              content: '',
              toolCalls: [
                createCall(
                  '2',
                  'read_file',
                  {
                    path: 'src.ts',
                  },
                ),
              ],
              finishReason: 'stop',
            },
            {
              content: 'Done',
              toolCalls: [],
              finishReason: 'stop',
            },
          ]);

        const toolRunner =
          createMockToolRunner(
            new Map(),
          );

        const history =
          createContextStore();

        const workspace =
          createTestWorkspace(tmpDir);

        await runTurn({
          model: 'test',
          history,
          gateway,
          toolRunner,
          workspace,
          config: {
            maxIterations: 5,
          },
          signal: new AbortController().signal,
        });

        const assistantMessages =
          history.messages.filter(
            message =>
              message.role === 'assistant',
          );

        assert.equal(
          assistantMessages.length,
          2,
        );
      });
    });

    describe('Workspace scope', () => {

      it('resolves relative paths against cwd', () => {
        assert.equal(
          resolveScope(
            '/home/user',
            'project',
          ),
          '/home/user/project',
        );
      });
    });
  });
});
