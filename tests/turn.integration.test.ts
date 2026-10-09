import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { STOP_REASONS, ROLE, TOOL_NAME, TOOL_ERROR_CODE } from '../src/protocol';
import { ContextOverflowError } from '../src/model/gateway';
import type { Message } from '../src/types';

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

  // The malformed call never ran; the corrected one did (this scripted model keeps sending it until the same-call limit).
  assert.ok(runs >= 1, 'the corrected call never ran');
  assert.ok(modelCalls >= 2, 'model was not given a round to correct the call');
});

it('answers a repeated read from its first result, and stops when the same call comes three times in a row', async () => {
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

  // The read runs once; the identical reads after it, with nothing changed between, get its result back. The third
  // identical call in a row still stops the turn.
  assert.equal(runs, 1);
  assert.equal(result.toolResults.length, 3);
  assert.equal(modelCalls, 3);
  assert.ok(toolsOffered[0]! > 0);
  assert.ok(toolsOffered[1]! > 0);
  assert.ok(toolsOffered[2]! > 0);
  assert.equal(toolsOffered.length, 3, 'no tool-free request after the stop');
  assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
});

it('a denied call ends the turn: it is not retried', async () => {
  const history = new ContextStore({ messages: [], budgetTokens: 8000 });
  let runs = 0;
  let modelCalls = 0;

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

  // An explicit denial is final for the turn: the call ran once, was denied, and no further request was made.
  assert.equal(runs, 1);
  assert.equal(result.toolResults.length, 1);
  assert.equal(modelCalls, 1);
  assert.equal(result.stopReason, STOP_REASONS.GUARD_STUCK);
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

describe('a turn stopped mid-work', () => {
  const overflow = () => new ContextOverflowError('prompt exceeds the context window');

  const toolReply = (id: string, name: string, args: Record<string, unknown>) => ({
    content: '',
    toolCalls: [{ id, type: 'function', function: { name, arguments: args } }],
    finishReason: 'tool_calls',
  });

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
