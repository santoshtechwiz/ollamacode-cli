import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { STOP_REASONS, ROLE, TOOL_NAME, TOOL_ERROR_CODE } from '../src/protocol';
import { ALWAYS_TOOLS } from '../src/context/tool-surface';
import { ContextOverflowError } from '../src/model/gateway';
import type { Message } from '../src/types';

describe('runTurn integration', () => {
  it('executes a tool call and records one exchange', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    let runs = 0;
    let modelCalls = 0;
    const result = await runTurn({
      model: 'test', history, config: { maxIterations: 2 }, toolsEnabled: true, toolsAllowed: true,
      gateway: {
        model: 'test', provider: { id: 'test' },
        async stream() {
          modelCalls++;
          const result = modelCalls === 1
            ? { content: '', toolCalls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: { path: 'missing.ts' } } }], finishReason: 'stop' }
            : { content: 'finished', toolCalls: [], finishReason: 'stop' };
          return { result, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run() { runs++; return { result: { ok: true, kind: 'text', display: 'read' } }; } } as any,
    });
    assert.equal(runs, 1);
    assert.equal(result.toolResults.length, 1);
    assert.equal(history.messages.filter((message) => message.role === 'tool').length, 1);
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
  });
});
it('executes multiple tool calls from one model response', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  const calls: string[] = [];
  let modelCalls = 0;

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 3 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream() {
        modelCalls++;

        const response = modelCalls === 1
          ? {
              content: '',
              toolCalls: [
                {
                  id: '1',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: { path: 'a.ts' },
                  },
                },
                {
                  id: '2',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: { path: 'b.ts' },
                  },
                },
              ],
              finishReason: 'stop',
            }
          : {
              content: 'done',
              toolCalls: [],
              finishReason: 'stop',
            };

        return {
          result: response,
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run(name: string, args: any) {
        calls.push(name);
        return {
          result: {
            ok: true,
            kind: 'text',
            display: args.path,
          },
        };
      },
    } as any,
  });

  assert.deepEqual(calls, ['read_file', 'read_file']);
  assert.equal(result.toolResults.length, 2);
  assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
  assert.equal(modelCalls, 2);
});

it('continues from tool results and produces a final answer', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let modelCalls = 0;

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 3 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream() {
        modelCalls++;

        const response = modelCalls === 1
          ? {
              content: '',
              toolCalls: [
                {
                  id: '1',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: { path: 'a.ts' },
                  },
                },
              ],
              finishReason: 'stop',
            }
          : {
              content: 'The file was read successfully.',
              toolCalls: [],
              finishReason: 'stop',
            };

        return {
          result: response,
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        return {
          result: {
            ok: true,
            kind: 'text',
            display: 'file contents',
          },
        };
      },
    } as any,
  });

  assert.equal(modelCalls, 2);
  assert.equal(result.answer, 'The file was read successfully.');
  assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
});

it('runs a call once when the model repeats it in the same batch', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let runs = 0;
  let modelCalls = 0;

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 3 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream() {
        modelCalls++;

        // The same call twice in one reply: the second must be answered from the first.
        if (modelCalls > 1) {
          return {
            result: { content: 'done', toolCalls: [], finishReason: 'stop' },
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        }

        const call = (id: string) => ({
          id,
          type: 'function' as const,
          function: { name: 'read_file', arguments: { path: 'same.ts' } },
        });

        return {
          result: {
            content: '',
            toolCalls: [call('a'), call('b')],
            finishReason: 'tool_calls',
          },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        runs++;
        return { result: { ok: true, kind: 'text', display: 'same file' } };
      },
    } as any,
  });

  assert.equal(runs, 1);
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.stopReason, STOP_REASONS.COMPLETE);

  // The second answer must be visibly a reuse. A reused result that renders exactly like the
  // original leaves the model no way to tell nothing ran, so it just asks again.
  const toolMessages = history.messages.filter((m) => m.role === 'tool');
  assert.equal(toolMessages.length, 2);
  assert.ok(!String(toolMessages[0].content).includes('Reused'));
  assert.ok(
    String(toolMessages[1].content).includes('Reused'),
    `the model was not told the call was reused: ${String(toolMessages[1].content)}`,
  );
});

it('lets the model correct a malformed call instead of ending the turn', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let runs = 0;
  let modelCalls = 0;

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 4 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream() {
        modelCalls++;
        // First reply is malformed and never reaches the executor; the model must get to fix it.
        const args = modelCalls === 1 ? { wrong_key: 'x' } : { path: 'real.ts' };

        return {
          result: {
            content: '',
            toolCalls: [
              { id: String(modelCalls), type: 'function', function: { name: 'read_file', arguments: args } },
            ],
            finishReason: 'tool_calls',
          },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        runs++;
        return { result: { ok: true, kind: 'text', display: 'real file' } };
      },
    } as any,
  });

  assert.equal(runs, 1);
  assert.ok(modelCalls >= 2, 'model was not given a round to correct the call');
});

it('does not execute the same successful read repeatedly', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let runs = 0;
  let modelCalls = 0;
  const toolsOffered: number[] = [];

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 8 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        modelCalls++;
        toolsOffered.push(request.tools?.length ?? 0);

        return {
          result: {
            content: '',
            toolCalls: [
              {
                id: String(modelCalls),
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: { path: 'same.ts' },
                },
              },
            ],
            finishReason: 'stop',
          },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        runs++;

        return {
          result: {
            ok: true,
            kind: 'text',
            display: 'same file',
          },
        };
      },
    } as any,
  });

  assert.equal(runs, 1);
  assert.equal(result.toolResults.length, 1);
  // Runs once however often re-asked: execute, reuse (a notice the model may act on), reuse again (the stall), a no-tools report.
  assert.equal(modelCalls, 4);
  assert.ok(toolsOffered[0]! > 0);
  assert.ok(toolsOffered[1]! > 0);
  assert.ok(toolsOffered[2]! > 0);
  assert.equal(toolsOffered[3], 0);
  assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
});

it('stops after one round that only reuses successful mutations', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let runs = 0;
  let modelCalls = 0;
  const toolsOffered: number[] = [];

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 8 },
    toolsEnabled: true,
    toolsAllowed: true,
    // The fake model writes straight away, so write_file is on the wire from the start.
    toolProfile: { always: ['write_file'] },
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        modelCalls++;
        toolsOffered.push(request.tools?.length ?? 0);

        return {
          result: {
            content: '',
            toolCalls: [
              {
                id: String(modelCalls),
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: { path: 'reuse-target.ts', content: 'hello' },
                },
              },
            ],
            finishReason: 'stop',
          },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        runs++;

        return {
          result: {
            ok: true,
            kind: 'text',
            display: 'created',
          },
        };
      },
    } as any,
  });

  // The first round executes the mutation; the second round only reuses it, so the world does
  // not move and the turn stops instead of asking the model a third time with tools.
  assert.equal(runs, 1, 'the mutation must not run again');
  assert.equal(result.toolResults.length, 1);
  assert.equal(modelCalls, 3);
  assert.ok(toolsOffered[0]! > 0);
  assert.ok(toolsOffered[1]! > 0);
  assert.equal(toolsOffered[2], 0);
  assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
});

it('closes a stuck turn with a plain-prose answer instead of silence', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let runs = 0;
  let modelCalls = 0;
  let toolsOffered: number | undefined;

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 6 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        modelCalls++;
        toolsOffered = request.tools?.length;

        // With tools the model loops on the same call; with none it finally answers.
        if (!request.tools?.length) {
          return {
            result: { content: 'I read the file. It contains hello.', toolCalls: [], finishReason: 'stop' },
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        }

        return {
          result: {
            content: '',
            toolCalls: [
              {
                id: String(modelCalls),
                type: 'function',
                function: { name: 'read_file', arguments: { path: 'loop.ts' } },
              },
            ],
            finishReason: 'stop',
          },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        runs++;
        return { result: { ok: true, kind: 'text', display: 'hello' } };
      },
    } as any,
  });

  assert.equal(runs, 1, 'the file must not be read over and over');
  assert.equal(toolsOffered, 0, 'the closing round must offer no tools');
  assert.equal(result.content, 'I read the file. It contains hello.');
  assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
});

it('stops when the iteration limit is reached', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let modelCalls = 0;

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 2 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream() {
        modelCalls++;

        return {
          result: {
            content: '',
            toolCalls: [
              {
                id: String(modelCalls),
                type: 'function',
                function: {
                  name: 'read_file',
                  arguments: { path: `${modelCalls}.ts` },
                },
              },
            ],
            finishReason: 'stop',
          },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        return {
          result: {
            ok: true,
            kind: 'text',
            display: 'data',
          },
        };
      },
    } as any,
  });

  assert.equal(modelCalls, 3, 'two steps, then one closing call for the account of what was done');
  assert.equal(result.stopReason, STOP_REASONS.MAX_ITERATIONS);
});

it('records denied tool execution without retrying the tool', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let runs = 0;
  let modelCalls = 0;
  let toolsOnClosingCall: unknown = 'unset';

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 6 },
    toolsEnabled: true,
    toolsAllowed: true,
    // The fake model writes straight away, so write_file is on the wire from the start.
    toolProfile: { always: ['write_file'] },
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(req: any) {
        modelCalls++;
        if (req?.toolsInPrompt === false) toolsOnClosingCall = req?.tools ?? req?.toolsOnWire;

        return {
          result: {
            content: '',
            toolCalls: [
              {
                id: String(modelCalls),
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: {
                    path: 'a.ts',
                    content: 'test',
                  },
                },
              },
            ],
            finishReason: 'stop',
          },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        runs++;

        return {
          result: {
            ok: false,
            kind: 'text',
            code: 'EDENIED',
            display: 'permission denied',
          },
        };
      },
    } as any,
  });

  assert.equal(runs, 1);
  assert.equal(result.toolResults.length, 1);
  // A permission denial is a gate, and a gate answers an identical retry the same way, so the
  // turn does not spend a round on that retry. It goes straight to the tool-free closing call so
  // the model can report what was refused. Well under maxIterations, so this still proves the
  // refusal ended the turn rather than the iteration limit.
  assert.equal(modelCalls, 2);
  assert.deepEqual(toolsOnClosingCall, []);
  assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
});

it('handles a model response with no tool calls', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 3 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream() {
        return {
          result: {
            content: 'No tools are required.',
            toolCalls: [],
            finishReason: 'stop',
          },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        throw new Error('tool should not execute');
      },
    } as any,
  });

  assert.equal(result.answer, 'No tools are required.');
  assert.equal(result.toolResults.length, 0);
  assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
});

it('records tool results in history in execution order', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let modelCalls = 0;

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 2 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream() {
        modelCalls++;

        return {
          result: modelCalls === 1
            ? {
                content: '',
                toolCalls: [
                  {
                    id: '1',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: { path: 'first.ts' },
                    },
                  },
                  {
                    id: '2',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments: { path: 'second.ts' },
                    },
                  },
                ],
                finishReason: 'stop',
              }
            : {
                content: 'done',
                toolCalls: [],
                finishReason: 'stop',
              },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run(_name: string, args: any) {
        return {
          result: {
            ok: true,
            kind: 'text',
            display: args.path,
          },
        };
      },
    } as any,
  });

  const toolMessages = history.messages.filter(
    (message) => message.role === 'tool',
  );

  assert.equal(toolMessages.length, 2);
  assert.equal(result.toolResults.length, 2);
  assert.equal(toolMessages[0]?.content, 'first.ts');
  assert.equal(toolMessages[1]?.content, 'second.ts');
});

describe('runTurn context-limit recovery', () => {
  const overflow = () => new ContextOverflowError('prompt exceeds the context window');

  const toolReply = (id: string, name: string, args: Record<string, unknown>) => ({
    content: '',
    toolCalls: [{ id, type: 'function', function: { name, arguments: args } }],
    finishReason: 'tool_calls',
  });

  const textReply = (content: string) => ({ content, toolCalls: [], finishReason: 'stop' });

  /** The assistant message that asked, plus the result that answered it. */
  const exchange = (id: string, name: string, args: Record<string, unknown>, result: string) => {
    const asked = { id, type: 'function' as const, function: { name, arguments: args } };
    return [asked, result] as const;
  };

  it('compacts silently, naming only the work on the loader', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('before: '.padEnd(12000, 'x'));
    history.addAssistant('before: '.padEnd(12000, 'y'));
    history.addUser('read the file a.ts', { pinned: true });
    let modelCalls = 0;
    const noted: string[] = [];
    const statuses: string[] = [];

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 5 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          if (modelCalls === 2) throw overflow();
          return {
            result: modelCalls === 1 ? toolReply('1', 'read_file', { path: 'a.ts' }) : textReply('The file says hello.'),
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: {
        async run() {
          return { result: { ok: true, kind: 'text', display: 'hello' } };
        },
      } as any,
      callbacks: {
        note: (text: string) => {
          noted.push(text);
        },
        onStatus: (text: string) => {
          statuses.push(text);
        },
      },
    });

    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    // Compaction is plumbing: no note, no token counts, just a plain loader label while it happens.
    assert.deepEqual(noted.filter((n) => /compact|token/i.test(n)), []);
    assert.ok(statuses.includes('Making room in the conversation'));
    assert.ok(statuses.every((st) => !/tok|step \d|compact/i.test(st)), statuses.join(' | '));
  });

  it('compacts on context overflow and continues the same turn', async () => {
    // A long prior conversation sits in the store; the overflow compacts it away, the
    // turn then proceeds exactly as if the overflow never happened.
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('before: '.padEnd(12000, 'x'));
    history.addAssistant('before: '.padEnd(12000, 'y'));
    // The live turn's request, pinned exactly the way executeTurn pins it.
    history.addUser('read the file a.ts', { pinned: true });
    let modelCalls = 0;
    let runs = 0;

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 5 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          if (modelCalls === 2) throw overflow();
          return {
            result: modelCalls === 1 ? toolReply('1', 'read_file', { path: 'a.ts' }) : textReply('The file says hello.'),
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: {
        async run() {
          runs++;
          return { result: { ok: true, kind: 'text', display: 'hello' } };
        },
      } as any,
    });

    assert.equal(runs, 1);
    assert.equal(modelCalls, 3);
    assert.equal(result.iterations, 2);
    assert.equal(result.content, 'The file says hello.');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    assert.ok(
      history.preservedSummary?.includes('trimmed'),
      `expected a compaction note in preservedSummary, got: ${history.preservedSummary}`,
    );
  });

  it('preserves the live exchange across compaction without burning iterations', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('old request');
    let modelCalls = 0;

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 3 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          if (modelCalls === 1) throw overflow();
          return {
            result: textReply('Continued after compaction.'),
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: {
        async run() {
          throw new Error('no tools were requested, none may run');
        },
      } as any,
    });

    // One overflow, one retry of the same iteration, then a completed turn.
    assert.equal(modelCalls, 2);
    assert.equal(result.iterations, 1);
    assert.equal(result.content, 'Continued after compaction.');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
  });

  it('does not re-run a tool that already succeeded before compaction', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    let modelCalls = 0;
    let runs = 0;
    const writeArgs = { path: 'reuse-target.ts', content: 'hello' };

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 6 },
      toolsEnabled: true,
      toolsAllowed: true,
      // The fake model writes straight away, so write_file is on the wire from the start.
      toolProfile: { always: ['write_file'] },
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream(request: any) {
          modelCalls++;
          if (modelCalls === 2) throw overflow();
          if (!request.tools?.length) {
            return {
              result: textReply('The write was saved.'),
              attempt: 1,
              retries: 0,
              startedAt: Date.now(),
            };
          }
          return {
            result: toolReply(String(modelCalls), 'write_file', writeArgs),
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: {
        async run() {
          runs++;
          return { result: { ok: true, kind: 'text', display: 'created' } };
        },
      } as any,
    });

    assert.equal(runs, 1, 'the mutation must not run again after compaction');
    assert.equal(modelCalls, 4);
    assert.equal(result.content, 'The write was saved.');
    assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
    const toolMessages = history.messages.filter((m) => m.role === 'tool');
    assert.equal(toolMessages.length, 2);
    assert.ok(
      String(toolMessages[1]?.content).includes('Reused'),
      `the post-compaction call was not answered from the earlier result: ${String(toolMessages[1]?.content)}`,
    );
  });

  it('keeps the live turn whole while older turns are trimmed', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('old ask: '.padEnd(20000, 'x'));
    history.addAssistant('old reply');
    history.addUser('now read a.ts', { pinned: true });
    let modelCalls = 0;
    let runs = 0;

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 5 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          if (modelCalls === 2) throw overflow();
          return {
            result: modelCalls === 1 ? toolReply('1', 'read_file', { path: 'a.ts' }) : textReply('The file says hello.'),
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: {
        async run() {
          runs++;
          return { result: { ok: true, kind: 'text', display: 'hello from a.ts' } };
        },
      } as any,
    });

    assert.equal(modelCalls, 3);
    assert.equal(runs, 1);
    assert.equal(result.content, 'The file says hello.');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    assert.ok(
      history.messages.some((m) => m.role === ROLE.TOOL && m.content.includes('hello from a.ts')),
      'the live turn tool result must survive the pass that trimmed the older turns',
    );
    assert.ok(
      !history.messages.some((m) => m.content.length > 1000),
      'the oversized earlier turn should have been trimmed away',
    );
  });

  it('fails after bounded compactions instead of looping', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('before: '.padEnd(12000, 'x'));
    let modelCalls = 0;

    const fail = runTurn({
      model: 'test',
      history,
      config: { maxIterations: 8 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          throw overflow();
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
    });

    await assert.rejects(fail, (err: unknown) => {
      const message = String((err as Error)?.message ?? err);
      assert.match(message, /grown too long to continue/);
      assert.doesNotMatch(message, /token|compaction/i);
      return true;
    });
    // One attempt plus one retry per compaction, then a terminal error — never a loop.
    assert.equal(modelCalls, 4);
  });

  it('never sends a request the builder already knows will not fit', async () => {
    // The live request alone overruns the window, so no amount of trimming older turns can
    // rescue it. Recovery must say so rather than put the call on the wire.
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('old ask: '.padEnd(20000, 'x'));
    history.addAssistant('old reply');
    history.addUser('the live request itself is far too long: '.padEnd(6000, 'y'), { pinned: true });
    const before = [...history.messages];
    let modelCalls = 0;

    const fail = runTurn({
      model: 'test',
      history,
      config: { maxIterations: 5, contextWindow: 1000, maxTokens: 256 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          return { result: textReply('never sent'), attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
    });

    await assert.rejects(fail, /grown too long to continue/);
    assert.equal(modelCalls, 0, 'a request the builder priced as oversized must not be sent');
  });

  it('leaves the record whole when recovery gives up', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('old ask: '.padEnd(20000, 'x'));
    history.addAssistant('old reply');
    history.addUser('the live request itself is far too long: '.padEnd(6000, 'y'), { pinned: true });
    const before = [...history.messages];

    const fail = runTurn({
      model: 'test',
      history,
      config: { maxIterations: 5, contextWindow: 1000, maxTokens: 256 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          return { result: textReply('never sent'), attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
    });

    await assert.rejects(fail, /grown too long to continue/);
    assert.deepEqual(
      history.messages,
      before,
      'a turn that ended in a terminal error must not hand back a truncated session',
    );
  });

  it('produces a clean terminal error when compaction fails', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    let modelCalls = 0;

    const fail = runTurn({
      model: 'test',
      history,
      config: { maxIterations: 4 },
      toolsEnabled: true,
      toolsAllowed: true,
      compactor: () => {
        throw new Error('summarizer unavailable');
      },
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          throw overflow();
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
    });

    await assert.rejects(fail, /could not be shortened to fit/);
    assert.equal(modelCalls, 1);
  });

  it('leaves normal turns without overflow untouched', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    const systemMessages: Message[] = [];
    let modelCalls = 0;

    const result = await runTurn({
      model: 'test',
      history,
      systemMessages,
      config: { maxIterations: 3 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          return {
            result: textReply('Nothing to compact here.'),
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
    });

    assert.equal(modelCalls, 1);
    assert.equal(result.iterations, 1);
    assert.equal(result.content, 'Nothing to compact here.');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    assert.equal(history.preservedSummary, null);
    assert.deepEqual(systemMessages, [], 'a turn that never overflowed must gain no recovery note');
  });

  it('names the calls already settled, with the arguments that tell them apart', async () => {
    // The note has to be read from the assistant message that asked and the rendered result
    // that answered — a tool result message carries neither on its own.
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('earlier turn 1');
    const [readCall, readResult] = exchange('1', 'read_file', { path: 'a.ts' }, 'hello from a.ts');
    history.addAssistant('', [readCall]);
    history.addToolResult(readCall, readResult);
    history.addUser('earlier turn 2');
    const [writeCall, writeResult] = exchange('2', 'write_file', { path: 'b.ts', content: 'z'.repeat(400) }, 'OK write_file — wrote b.ts');
    history.addAssistant('', [writeCall]);
    history.addToolResult(writeCall, writeResult);
    history.addUser('now do the thing', { pinned: true });
    const systemMessages: Message[] = [];
    let modelCalls = 0;

    const result = await runTurn({
      model: 'test',
      history,
      systemMessages,
      config: { maxIterations: 3 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          if (modelCalls === 1) throw overflow();
          return { result: textReply('Done.'), attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
    });

    assert.equal(modelCalls, 2);
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    const note = systemMessages.map((m) => m.content).join('\n');
    assert.ok(note.includes('read_file(path="a.ts")'), `the note lost the read: ${note}`);
    assert.ok(note.includes('write_file(path="b.ts")'), `the note lost the write: ${note}`);
    assert.ok(
      !note.includes('z'.repeat(400)),
      'a file body inlined into the note costs more room than the note is worth',
    );
  });

  it('leaves failed calls out of the note — they are work still to do', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('earlier turn');
    const [goodCall, goodResult] = exchange('1', 'read_file', { path: 'ok.ts' }, 'hello from ok.ts');
    const [badCall, badResult] = exchange('2', 'read_file', { path: 'missing.ts' }, 'ERROR read_file [ENOENT] — no such file: missing.ts');
    history.addAssistant('', [goodCall]);
    history.addToolResult(goodCall, goodResult);
    history.addAssistant('', [badCall]);
    history.addToolResult(badCall, badResult);
    history.addUser('now retry the read', { pinned: true });
    const systemMessages: Message[] = [];
    let modelCalls = 0;

    await runTurn({
      model: 'test',
      history,
      systemMessages,
      config: { maxIterations: 3 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          if (modelCalls === 1) throw overflow();
          return { result: textReply('Done.'), attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
    });

    const note = systemMessages.map((m) => m.content).join('\n');
    assert.ok(note.includes('read_file(path="ok.ts")'), `the note lost the read that worked: ${note}`);
    assert.ok(
      !note.includes('missing.ts'),
      `a read that failed was announced as already done: ${note}`,
    );
  });

  it('keeps one note however many passes the recovery takes', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('earlier turn');
    const [ask, result] = exchange('1', 'read_file', { path: 'a.ts' }, 'hello from a.ts');
    history.addAssistant('', [ask]);
    history.addToolResult(ask, result);
    history.addUser('now do the thing', { pinned: true });
    const systemMessages: Message[] = [];
    let modelCalls = 0;

    await runTurn({
      model: 'test',
      history,
      systemMessages,
      config: { maxIterations: 3 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          if (modelCalls <= 2) throw overflow();
          return { result: textReply('Done.'), attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: { async run() { throw new Error('must not run'); } } as any,
    });

    assert.equal(modelCalls, 3, 'two overflows, two passes');
    assert.equal(
      systemMessages.length,
      1,
      `a note per pass grows the request the recovery is trying to shrink: ${JSON.stringify(systemMessages)}`,
    );
    assert.ok(!history.preservedSummary?.includes('Already completed'), 'the note lives in one place only');
  });

  it('continues the task correctly after multiple compactions', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    for (let i = 0; i < 3; i++) {
      history.addUser('old user: '.padEnd(100, `u${i}`));
      history.addAssistant('old assistant: '.padEnd(100, `a${i}`));
    }
    history.addUser('read the file a.ts', { pinned: true });

    let modelCalls = 0;
    let runs = 0;

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 8, contextWindow: 16000, maxTokens: 512 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream(request: any) {
          modelCalls++;
          if (modelCalls <= 3) throw overflow();
          if (modelCalls > 4) {
            return { result: textReply('Finally done.'), attempt: 1, retries: 0, startedAt: Date.now() };
          }
          return { result: toolReply(String(modelCalls), 'read_file', { path: 'a.ts' }), attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: {
        async run() {
          runs++;
          return { result: { ok: true, kind: 'text', display: 'hello' } };
        },
      } as any,
    });

    assert.equal(modelCalls, 5, 'three overflows retried, then the work, then the answer');
    assert.equal(runs, 1);
    assert.equal(result.content, 'Finally done.');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
  });

  it('keeps the work done after the first compaction when recovery gives up', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    history.addUser('write the file', { pinned: true });
    const ran: string[] = [];
    let modelCalls = 0;

    const fail = runTurn({
      model: 'test',
      history,
      config: { maxIterations: 4 },
      toolsEnabled: true,
      toolsAllowed: true,
      toolProfile: { always: ['write_file'] },
      // A pass that frees nothing: every later request overflows again until the budget runs out.
      compactor: (_store, capacityTokens) => ({ dropped: 0, capacityTokens }),
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          // Step 1 overflows once, is compacted, then writes; step 2 never fits again.
          if (modelCalls === 2) return { result: toolReply('w1', 'write_file', { path: 'a.txt', content: 'x' }), attempt: 1, retries: 0, startedAt: Date.now() };
          throw overflow();
        },
      } as any,
      toolRunner: {
        async run(name: string, args: any) {
          ran.push(`${name}:${args.path}`);
          return { result: { ok: true, kind: 'text', display: 'wrote a.txt' } };
        },
      } as any,
    });

    await assert.rejects(fail, /grown too long to continue/);
    assert.deepEqual(ran, ['write_file:a.txt']);
    assert.ok(
      history.messages.some((m) => m.role === ROLE.TOOL && String(m.content).includes('wrote a.txt')),
      'the write happened, so the session must still record it',
    );
    assert.equal(history.messages[0].content, 'write the file');
  });
});

describe('closingAnswer', () => {
  const overflow = () => new ContextOverflowError('prompt exceeds the context window');

  const toolReply = (id: string, name: string, args: Record<string, unknown>) => ({
    content: '',
    toolCalls: [{ id, type: 'function', function: { name, arguments: args } }],
    finishReason: 'tool_calls',
  });

  const textReply = (content: string) => ({ content, toolCalls: [], finishReason: 'stop' });

  /**
   * A gateway that loops on one call until the guard stops it, so the turn really does end in
   * `closingAnswer`. Counts the tool-less calls it is given, since that is the closing round,
   * and the reply budget each one asked for.
   */
  const stuckGateway = (closing: () => any) => {
    const seen = { closing: 0, budgets: [] as number[] };
    return {
      seen,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream(request: any) {
          if (!request.tools?.length) {
            seen.closing++;
            seen.budgets.push(Number(request.replyBudget) || 0);
            return { result: closing(), attempt: 1, retries: 0, startedAt: Date.now() };
          }
          return {
            result: toolReply(String(seen.closing + 1), 'read_file', { path: 'loop.ts' }),
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
    };
  };

  it('is not called when the model already answered in prose', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    let modelCalls = 0;
    let closingCalls = 0;

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 6 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream(request: any) {
          modelCalls++;
          if (!request.tools?.length) closingCalls++;
          return {
            result:
              modelCalls === 1
                ? toolReply('1', 'read_file', { path: 'a.ts' })
                : textReply('I read it. It holds hello from a.ts.'),
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: {
        async run() {
          return { result: { ok: true, kind: 'text', display: 'hello from a.ts' } };
        },
      } as any,
    });

    assert.equal(closingCalls, 0, 'a turn the model finished itself needs no closing round');
    assert.equal(modelCalls, 2);
    assert.equal(result.content, 'I read it. It holds hello from a.ts.');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
  });

  it('reserves the reply budget the closing round asks for', async () => {
    // A backend refuses a prompt that leaves no room for the reply it was asked for, so the
    // closing request has to be assembled against the budget the gateway will actually use.
    // Sizing it against the bare `maxTokens` the session was configured with leaves the reply
    // asking for more tokens than the prompt kept space for, and `closingAnswer` swallows the
    // rejection — the turn ends with no answer at all.
    const { seen, gateway } = stuckGateway(() => textReply('I read the file. It holds hello.'));
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 6, maxTokens: 2048, contextWindow: 32000 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway,
      toolRunner: {
        async run() {
          return { result: { ok: true, kind: 'text', display: 'hello' } };
        },
      } as any,
    });

    assert.equal(seen.closing, 1);
    assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
    assert.equal(result.content, 'I read the file. It holds hello.');
    // The gateway asks for max(config.maxTokens, 4096) whatever the turn asked for.
    assert.deepEqual(seen.budgets, [4096]);
    assert.equal(
      history.lastBudget?.outputReserve,
      Math.max(2048, 4096),
      'the closing request must reserve what its reply asks for',
    );
  });

  it('reports an empty closing answer as no answer rather than blank prose', async () => {
    const { gateway } = stuckGateway(() => ({ content: '   ', toolCalls: [], finishReason: 'stop' }));
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 6 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway,
      toolRunner: { async run() { return { result: { ok: true, kind: 'text', display: 'data' } }; } } as any,
    });

    assert.equal(result.content, '');
  assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
});

it('offers the tool index, then only the schema the model asked for', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  const offered: string[][] = [];
  let modelCalls = 0;

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 4 },
    toolsEnabled: true,
    toolsAllowed: true,
    // An empty always-profile, so the first request carries the index and nothing else.
    toolProfile: { always: [] },
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        modelCalls++;
        offered.push((request.tools ?? []).map((t: any) => t.function.name));

        // Ask for two tools, then use one of them: the point of the test is that both land.
        const toolCalls = modelCalls === 1
          ? [{ id: '1', type: 'function', function: { name: TOOL_NAME.LOAD_TOOLS, arguments: { tools: ['read_file', 'write_file'] } } }]
          : [];

        return {
          result: { content: 'done', toolCalls, finishReason: 'stop' },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        return { result: { ok: true, kind: 'text', display: 'ok' } };
      },
    } as any,
  });

  // First request carries the index alone, not every schema in the registry.
  assert.deepEqual(offered[0], [TOOL_NAME.LOAD_TOOLS]);
  // The second carries the two the model asked for, discovered in one call.
  assert.deepEqual(offered[1], [TOOL_NAME.LOAD_TOOLS, 'read_file', 'write_file']);
  assert.equal(modelCalls, 2);
  assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
});

it('advertises the always-available tools in full and keeps them out of the index', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  const offered: { names: string[]; index: string }[] = [];

  await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 2 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        const wire = request.tools ?? [];
        const load = wire.find((t: any) => t.function.name === TOOL_NAME.LOAD_TOOLS);
        offered.push({
          names: wire.map((t: any) => t.function.name),
          index: String(load?.function?.description ?? ''),
        });
        return {
          result: { content: 'done', toolCalls: [], finishReason: 'stop' },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: { async run() { return { result: { ok: true, kind: 'text', display: 'ok' } }; } } as any,
  });

  // The three cheap tools a turn needs before it can decide anything else, with real schemas.
  assert.deepEqual(offered[0]!.names, [TOOL_NAME.LOAD_TOOLS, 'read_file', 'list_directory', 'ask_user']);
  assert.equal(ALWAYS_TOOLS.length, 3);
  for (const tool of ALWAYS_TOOLS) {
    assert.ok(offered[0]!.names.includes(tool), `${tool} should be advertised up front`);
    // Already advertised in full, so listing it in the index would only cost tokens twice.
    assert.ok(!offered[0]!.index.includes(`${tool} —`), `${tool} should not also be in the index`);
  }
  // The index still carries what discovery is for.
  assert.match(offered[0]!.index, /edit_file —/);
});

it('refuses to run a tool whose schema was never loaded', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let runs = 0;
  const offered: string[][] = [];

  await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 3 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        offered.push((request.tools ?? []).map((t: any) => t.function.name));
        // A model reaching straight for a tool it was never shown the schema of.
        const toolCalls = offered.length === 1
          ? [{
              id: '1',
              type: 'function',
              function: { name: 'write_file', arguments: { path: 'a.ts', content: 'x' } },
            }]
          : [];

        return {
          result: { content: 'done', toolCalls, finishReason: 'stop' },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        runs++;
        return { result: { ok: true, kind: 'text', display: 'should not happen' } };
      },
    } as any,
  });

  // The whole point: nothing reached the executor, because the model never saw the arguments.
  assert.equal(runs, 0, 'a tool must not execute against a schema the model never saw');

  // And the model is told why, in the tool result it reads next — not left to guess.
  const told = history.messages.find((m) => m.role === ROLE.TOOL);
  assert.match(String(told?.content), /before its schema was loaded/);
  assert.match(String(told?.content), /full schema is in your next request/);

  // And the schema is on the wire next time, so the model can call it the intended way.
  assert.ok(!offered[0]!.includes('write_file'), 'it must not be advertised before it is loaded');
  assert.ok(offered[1]!.includes('write_file'), 'refusing the call loads it for the next request');
});

it('lets the model retry a tool it called before its schema was loaded', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  const args = { command: 'npm test' };
  const offered: string[][] = [];
  const ran: string[] = [];

  const result = await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 4 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        offered.push((request.tools ?? []).map((t: any) => t.function.name));
        // Reaches for the tool twice, exactly as the retry the refusal invites.
        const toolCalls = offered.length <= 2
          ? [{ id: `c${offered.length}`, type: 'function', function: { name: 'exec_shell', arguments: args } }]
          : [];

        return {
          result: { content: 'done', toolCalls, finishReason: 'stop' },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run(name: string, _args: any) {
        ran.push(name);
        return { result: { ok: true, kind: 'text', display: 'ok' } };
      },
    } as any,
  });

  // The refusal loaded the schema, so the identical second call runs. Blocking it would strand
  // the turn: the model has no other way to reach the tool it was just told to call.
  assert.deepEqual(ran, ['exec_shell'], 'the retry after a schema-only refusal must reach the tool');
  assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
  assert.ok(!offered[0]!.includes('exec_shell'), 'it must not be advertised before it is loaded');
  assert.ok(offered[1]!.includes('exec_shell'), 'the refusal is what puts it on the wire');
});

it('keeps a loaded tool on the wire for the next turn of the same session', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  const state: any = { mutationCount: 0 };
  const ran: string[] = [];
  const toolRunner = {
    async run(name: string, _args: any) {
      ran.push(name);
      return { result: { ok: true, kind: 'text', display: 'ok' } };
    },
  } as any;

  let first = 0;
  await runTurn({
    model: 'test',
    history,
    state,
    config: { maxIterations: 4 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        first++;
        const toolCalls = first === 1
          ? [{ id: 'a', type: 'function', function: { name: TOOL_NAME.LOAD_TOOLS, arguments: { tools: ['exec_shell'] } } }]
          : first === 2
            ? [{ id: 'b', type: 'function', function: { name: 'exec_shell', arguments: { command: 'npm test' } } }]
            : [];
        return {
          result: { content: 'done', toolCalls, finishReason: 'stop' },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner,
  });

  // A new turn, same session. The conversation still remembers the tool, so the wire has to
  // agree with it: otherwise the model is told it never saw a schema it was shown last turn,
  // and refuses to make progress for a reason that does not exist.
  const second: string[][] = [];
  let calls = 0;
  await runTurn({
    model: 'test',
    history,
    state,
    config: { maxIterations: 2 },
    toolsEnabled: true,
    toolsAllowed: true,
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        calls++;
        second.push((request.tools ?? []).map((t: any) => t.function.name));
        const toolCalls = calls === 1
          ? [{ id: 'c', type: 'function', function: { name: 'exec_shell', arguments: { command: 'npm test' } } }]
          : [];
        return {
          result: { content: 'done', toolCalls, finishReason: 'stop' },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner,
  });

  assert.ok(second[0]!.includes('exec_shell'), 'the tool a previous turn loaded was offloaded again');

  // The refusal is the failure this guards against: the model is told it never saw a schema
  // the session had already put on the wire. Whether the call then runs or is served from the
  // verification store is a separate decision this test has no stake in.
  const refusals = history.messages.filter(
    (m) => m.role === ROLE.TOOL && /before its schema was loaded/.test(String(m.content)),
  );
  assert.deepEqual(refusals, [], 'a remembered tool must not be refused for a missing schema');
});

it('never puts a tool on the wire the registry does not hold', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  const offered: string[][] = [];
  let modelCalls = 0;

  await runTurn({
    model: 'test',
    history,
    config: { maxIterations: 3 },
    toolsEnabled: true,
    toolsAllowed: true,
    toolProfile: { always: [] },
    gateway: {
      model: 'test',
      provider: { id: 'test' },
      async stream(request: any) {
        modelCalls++;
        offered.push((request.tools ?? []).map((t: any) => t.function.name));

        const toolCalls = modelCalls === 1
          ? [{
              id: '1',
              type: 'function',
              function: { name: TOOL_NAME.LOAD_TOOLS, arguments: { tools: ['read_file', 'not_a_real_tool'] } },
            }]
          : [];

        return {
          result: { content: 'done', toolCalls, finishReason: 'stop' },
          attempt: 1,
          retries: 0,
          startedAt: Date.now(),
        };
      },
    } as any,
    toolRunner: {
      async run() {
        return { result: { ok: true, kind: 'text', display: 'ok' } };
      },
    } as any,
  });

  // One real tool was resolved; the invented name resolved to nothing and is absent.
  assert.deepEqual(offered[1], [TOOL_NAME.LOAD_TOOLS, 'read_file']);
});


  it('survives a closing round the backend rejects', async () => {
    const { gateway } = stuckGateway(() => {
      throw new Error('closing model failed');
    });
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 6 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway,
      toolRunner: { async run() { return { result: { ok: true, kind: 'text', display: 'data' } }; } } as any,
    });

    // The guard's own stop reason stands; a failed closing round only costs the prose.
    assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
    assert.equal(result.content, '');
  });

  it('stops the turn and never asks again once the signal aborts', async () => {
    const controller = new AbortController();
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    let modelCalls = 0;

    const result = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 6 },
      toolsEnabled: true,
      toolsAllowed: true,
      signal: controller.signal,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          return {
            result: toolReply(String(modelCalls), 'read_file', { path: 'a.ts' }),
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: {
        async run() {
          controller.abort();
          return { result: { ok: true, kind: 'text', display: 'data' } };
        },
      } as any,
    });

    assert.equal(result.stopReason, STOP_REASONS.CANCELLED);
    assert.equal(modelCalls, 1, 'no round may follow the abort, least of all a closing one');
  });
});

describe('runTurn todo list', () => {
  const PLAN = 'Here is the task list. Want me to start implementing this?';
  const OPEN = [
    { content: 'Add the dependency', status: 'pending' },
    { content: 'Create src/db.js', status: 'pending' },
  ];
  const DONE = OPEN.map((todo) => ({ ...todo, status: 'completed' }));

  const todoCall = (todos: { content: string; status: string; }[], id: string) => ({
    content: '',
    toolCalls: [
      {
        id,
        type: 'function',
        function: { name: 'todo_write', arguments: { todos } },
      },
    ],
    finishReason: 'stop',
  });

  it('ends the turn when the model asks before starting the list it wrote', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    const workspaceState: any = { todos: [] };
    let modelCalls = 0;

    const result = await runTurn({
      model: 'test',
      history,
      state: workspaceState,
      config: { maxIterations: 5 },
      toolsEnabled: true,
      toolsAllowed: true,
      toolProfile: { always: ['todo_write'] },
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          return {
            result:
              modelCalls === 1
                ? todoCall(OPEN, 't1')
                : { content: PLAN, toolCalls: [], finishReason: 'stop' },
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: {
        async run(_name: string, args: any) {
          workspaceState.todos = args.todos;
          return { result: { ok: true, kind: 'text', display: 'ok' } };
        },
      } as any,
    });

    assert.equal(modelCalls, 2, 'a reply in text is the answer, open list or not — the person decides what comes next');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    assert.equal(result.content, PLAN);
  });

  it('leaves a list left over from an earlier turn alone', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    const workspaceState: any = { todos: OPEN };
    let modelCalls = 0;

    const result = await runTurn({
      model: 'test',
      history,
      state: workspaceState,
      config: { maxIterations: 5 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          return {
            result: { content: 'The auth module reads the token from the request.', toolCalls: [], finishReason: 'stop' },
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
    } as any);

    assert.equal(modelCalls, 1, 'an open list from another turn is not this turn\'s work');
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    assert.match(result.content, /auth module/);
  });

  it('accepts the reply when the model finishes the list it wrote', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    const workspaceState: any = { todos: [] };
    let modelCalls = 0;

    const result = await runTurn({
      model: 'test',
      history,
      state: workspaceState,
      config: { maxIterations: 5 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          modelCalls++;
          return {
            result:
              modelCalls === 1
                ? todoCall(OPEN, 't1')
                : modelCalls === 2
                  ? {
                      content: '',
                      toolCalls: [
                        {
                          id: 'read',
                          type: 'function',
                          function: { name: 'read_file', arguments: { path: 'src/db.js' } },
                        },
                      ],
                      finishReason: 'stop',
                    }
                  : { content: 'Both steps are done.', toolCalls: [], finishReason: 'stop' },
            attempt: 1,
            retries: 0,
            startedAt: Date.now(),
          };
        },
      } as any,
      toolRunner: {
        async run(name: string, args: any) {
          workspaceState.todos = name === 'todo_write' ? args.todos : DONE;
          return { result: { ok: true, kind: 'text', display: 'ok' } };
        },
      } as any,
    });

    assert.equal(modelCalls, 3);
    assert.equal(result.stopReason, STOP_REASONS.COMPLETE);
    assert.equal(result.content, 'Both steps are done.');
  });

  it('keeps the turn going when the model only closes a step in the list', async () => {
    const history = new ContextStore({ messages: [], budgetTokens: 8000 });
    const workspaceState: any = { todos: [] };
    const at = (statuses: string[]) =>
      OPEN.map((todo, i) => ({ content: todo.content, status: statuses[i] }));
    const write = (id: string, path: string) => ({
      content: '',
      toolCalls: [
        { id, type: 'function', function: { name: 'write_file', arguments: { path, content: 'export const x = 1;' } } },
      ],
      finishReason: 'stop',
    });
    let modelCalls = 0;

    const result = await runTurn({
      model: 'test',
      history,
      state: workspaceState,
      config: { maxIterations: 8 },
      toolsEnabled: true,
      toolsAllowed: true,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          const round = modelCalls++;
          // Round 2 is the regression: the model does exactly what the tool description tells it to
          // and marks the finished step done. That round touches no file, and reading it as a stall
          // is what used to end the turn here with the second step never done.
          const reply =
            round === 0
              ? todoCall(OPEN, 't1')
              : round === 1
                ? write('w1', 'src/lib/slugify.js')
                : round === 2
                  ? todoCall(at(['completed', 'pending']), 't2')
                  : round === 3
                    ? write('w2', 'src/lib/slugify.test.js')
                    : round === 4
                      ? todoCall(at(['completed', 'completed']), 't3')
                      : { content: 'Both steps are done.', toolCalls: [], finishReason: 'stop' };

          return { result: reply, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: {
        async run(name: string, args: any) {
          if (name === 'todo_write') workspaceState.todos = args.todos;
          workspaceState.mutationCount = (workspaceState.mutationCount ?? 0) + 1;
          return { result: { ok: true, kind: 'text', display: 'ok' } };
        },
      } as any,
    });

    assert.equal(result.stopReason, STOP_REASONS.COMPLETE, `model calls: ${modelCalls}`);
    assert.equal(modelCalls, 6, 'closing a step is bookkeeping, not a reason to stop the turn');
    assert.equal(result.content, 'Both steps are done.');
  });
});
