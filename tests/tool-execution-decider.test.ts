import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideToolExecution } from '../src/agent/turn/tool-execution-decider';
import { STOP_REASONS, TOOL_ERROR_CODE } from '../src/protocol';
import type { ToolCall, ToolResult } from '../src/types';
import type { TurnState } from '../src/agent/turn/turn-state';

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: args } };
}

function result(ok: boolean, code?: string): ToolResult {
  return { ok, kind: 'text', ...(code ? { code } : {}) };
}

function state(toolCalls: TurnState['toolCalls'] = []): TurnState {
  return { iteration: 1, maxIterations: 10, toolCalls, answer: undefined, stopReason: undefined };
}

describe('decideToolExecution', () => {
  it('executes a new call', () => {
    assert.equal(decideToolExecution(call('1', 'read_file', { path: 'a.ts' }), state()).kind, 'EXECUTE');
  });

  it('lets a call through after a refusal that only loaded its schema', () => {
    // Refusing a call for a missing schema loaded the schema. Counting that refusal as an
    // attempt would lock the tool for the rest of the turn, which is the one outcome it was
    // not trying to produce.
    const pending = {
      callId: '1', name: 'exec_shell', args: { command: 'npm test' },
      result: result(false, TOOL_ERROR_CODE.EINVAL),
      isRepeat: true, schemaPending: true, at: 1, target: null, targetStamp: null, world: 0,
    };
    const decision = decideToolExecution(call('2', 'exec_shell', { command: 'npm test' }), state([pending]));

    assert.equal(decision.kind, 'EXECUTE');
  });

  it('still refuses a real declined call that follows a schema-only refusal', () => {
    const pending = {
      callId: '1', name: 'exec_shell', args: { command: 'npm test' },
      result: result(false, TOOL_ERROR_CODE.EINVAL),
      isRepeat: true, schemaPending: true, at: 1, target: null, targetStamp: null, world: 0,
    };
    const denied = {
      callId: '2', name: 'exec_shell', args: { command: 'npm test' },
      result: result(false, TOOL_ERROR_CODE.EDENIED),
      isRepeat: true, at: 1, target: null, targetStamp: null, world: 0,
    };
    const decision = decideToolExecution(call('3', 'exec_shell', { command: 'npm test' }), state([pending, denied]));

    assert.equal(decision.kind, 'REJECT');
  });

  it('reuses a successful call with the same workspace world', () => {
    const prior = {
      callId: '1', name: 'read_file', args: { path: 'a.ts' }, result: result(true),
      isRepeat: false, at: 1, target: null, targetStamp: null, world: 2,
    };
    const decision = decideToolExecution(call('2', 'read_file', { path: 'a.ts' }), state([prior]), { mutationCount: 2 });
    assert.equal(decision.kind, 'REUSE');
    assert.equal(decision.priorResult.data?.reused, true);
  });

  it('rejects a repeated declined call', () => {
    const prior = {
      callId: '1', name: 'write_file', args: { path: 'a.ts', content: 'x' }, result: result(false, TOOL_ERROR_CODE.EDENIED),
      isRepeat: false, at: 1, target: 'a.ts', targetStamp: null, world: 0,
    };
    const decision = decideToolExecution(call('2', 'write_file', { path: 'a.ts', content: 'x' }), state([prior]));
    assert.equal(decision.kind, 'REJECT');
    assert.equal('stopReason' in decision, false);
  });

  it('stops when a provider reuses a call id with different arguments', () => {
    const prior = {
      callId: 'same', name: 'read_file', args: { path: 'a.ts' }, result: result(true),
      isRepeat: false, at: 1, target: null, targetStamp: null, world: 0,
    };
    const decision = decideToolExecution(call('same', 'read_file', { path: 'b.ts' }), state([prior]));
    assert.deepEqual(decision, { kind: 'STOP', reason: STOP_REASONS.GUARD_STUCK });
  });
  it('executes the same successful read after the workspace world changes', () => {
    const prior = {
      callId: '1',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: result(true),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: 'v1',
      world: 1,
    };

    const decision = decideToolExecution(
      call('2', 'read_file', { path: 'a.ts' }),
      state([prior]),
      { mutationCount: 2 },
    );

    assert.equal(decision.kind, 'EXECUTE');
  });

  it('does not reuse a failed previous call', () => {
    const prior = {
      callId: '1',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: result(false, TOOL_ERROR_CODE.EFAILED),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: null,
      world: 0,
    };

    const decision = decideToolExecution(
      call('2', 'read_file', { path: 'a.ts' }),
      state([prior]),
    );

    assert.equal(decision.kind, 'EXECUTE');
  });

  it('executes a call when the tool arguments are different', () => {
    const prior = {
      callId: '1',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: result(true),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: null,
      world: 0,
    };

    const decision = decideToolExecution(
      call('2', 'read_file', { path: 'b.ts' }),
      state([prior]),
    );

    assert.equal(decision.kind, 'EXECUTE');
  });

  it('executes a different tool even when arguments match', () => {
    const prior = {
      callId: '1',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: result(true),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: null,
      world: 0,
    };

    const decision = decideToolExecution(
      call('2', 'write_file', { path: 'a.ts' }),
      state([prior]),
    );

    assert.equal(decision.kind, 'EXECUTE');
  });

  it('stops when the same call id is reused with a different tool', () => {
    const prior = {
      callId: 'same',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: result(true),
      isRepeat: false,
      at: 1,
      target: null,
      targetStamp: null,
      world: 0,
    };

    const decision = decideToolExecution(
      call('same', 'write_file', { path: 'a.ts', content: 'x' }),
      state([prior]),
    );

    assert.deepEqual(decision, {
      kind: 'STOP',
      reason: STOP_REASONS.GUARD_STUCK,
    });
  });

  it('reuses the latest matching successful call', () => {
    const first = {
      callId: '1',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: result(true),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: null,
      world: 0,
    };

    const second = {
      callId: '2',
      name: 'read_file',
      args: { path: 'b.ts' },
      result: result(true),
      isRepeat: false,
      at: 2,
      target: 'b.ts',
      targetStamp: null,
      world: 0,
    };

    const decision = decideToolExecution(
      call('3', 'read_file', { path: 'a.ts' }),
      state([first, second]),
    );

    assert.equal(decision.kind, 'REUSE');
    assert.equal(decision.priorResult.data?.reused, true);
  });

  it('does not treat a different target stamp as reusable', () => {
    const prior = {
      callId: '1',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: result(true),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: 'v1',
      world: 1,
    };

    const decision = decideToolExecution(
      call('2', 'read_file', { path: 'a.ts' }),
      state([prior]),
      {
        mutationCount: 1,
        targetStamp: 'v2',
      },
    );

    assert.equal(decision.kind, 'EXECUTE');
  });

  it('rejects a repeated denied call even when the provider changes the call id', () => {
    const prior = {
      callId: '1',
      name: 'delete_file',
      args: { path: 'a.ts' },
      result: result(false, TOOL_ERROR_CODE.EDENIED),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: null,
      world: 0,
    };

    const decision = decideToolExecution(
      call('new-id', 'delete_file', { path: 'a.ts' }),
      state([prior]),
    );

    assert.equal(decision.kind, 'REJECT');
  });

  it('reuses an identical mutation whose target still matches what that call produced', () => {
    // The write ran at world 0 and produced a file whose stamp is 'after'. The world has since
    // advanced, but the file is exactly as that write left it, so the request is already satisfied.
    const prior = {
      callId: '1',
      name: 'write_file',
      args: { path: 'a.ts', content: 'x' },
      result: result(true),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: null,
      afterStamp: 'after',
      world: 0,
    };

    const decision = decideToolExecution(
      call('2', 'write_file', { path: 'a.ts', content: 'x' }),
      state([prior]),
      { mutationCount: 3, targetStamp: 'after' },
    );

    assert.equal(decision.kind, 'REUSE');
  });

  it('executes an identical mutation when the target no longer matches what it produced', () => {
    const prior = {
      callId: '1',
      name: 'write_file',
      args: { path: 'a.ts', content: 'x' },
      result: result(true),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: null,
      afterStamp: 'after',
      world: 0,
    };

    const decision = decideToolExecution(
      call('2', 'write_file', { path: 'a.ts', content: 'x' }),
      state([prior]),
      { mutationCount: 3, targetStamp: 'changed-again' },
    );

    assert.equal(decision.kind, 'EXECUTE');
  });

  it('executes a read again after the file it read was written to', () => {
    // The read saw 'v1'. The write then changed the file, so the same read must run again.
    const read = {
      callId: '1',
      name: 'read_file',
      args: { path: 'a.ts' },
      result: result(true),
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: 'v1',
      afterStamp: 'v1',
      world: 0,
    };
    const write = {
      callId: '2',
      name: 'write_file',
      args: { path: 'a.ts', content: 'y' },
      result: result(true),
      isRepeat: false,
      at: 2,
      target: 'a.ts',
      targetStamp: 'v1',
      afterStamp: 'v2',
      world: 1,
    };

    const decision = decideToolExecution(
      call('3', 'read_file', { path: 'a.ts' }),
      state([read, write]),
      { mutationCount: 1, targetStamp: 'v2' },
    );

    assert.equal(decision.kind, 'EXECUTE');
  });

  it('does not reuse a non-idempotent call such as an append', () => {
    // Appending the same content again appends again, so the prior result does not stand in for it.
    const prior = {
      callId: '1',
      name: 'write_file',
      args: { path: 'a.ts', content: 'x', mode: 'append' },
      result: { ...result(true), data: { idempotent: false } } as ToolResult,
      isRepeat: false,
      at: 1,
      target: 'a.ts',
      targetStamp: null,
      afterStamp: 'after',
      world: 0,
    };

    const decision = decideToolExecution(
      call('2', 'write_file', { path: 'a.ts', content: 'x', mode: 'append' }),
      state([prior]),
      { mutationCount: 3, targetStamp: 'after' },
    );

    assert.equal(decision.kind, 'EXECUTE');
  });

  it('executes a call when there is no previous tool history', () => {
    const decision = decideToolExecution(
      call('1', 'read_file', { path: 'a.ts' }),
      state(),
    );

    assert.deepEqual(decision, { kind: 'EXECUTE' });
  });

  it('reuses a repeat whose arguments come in a different order', () => {
    const first = {
      callId: '1', name: 'read_file', args: { path: 'a.ts', offset: 10 },
      result: result(true), isRepeat: false, at: 1, target: null, targetStamp: null, world: 0,
    };
    const decision = decideToolExecution(call('2', 'read_file', { offset: 10, path: 'a.ts' }), state([first]));

    assert.equal(decision.kind, 'REUSE');
  });

  it('runs a volatile tool again instead of handing back its earlier result', () => {
    const first = {
      callId: '1', name: 'exec_shell', args: { command: 'git status' },
      result: result(true), isRepeat: false, at: 1, target: null, targetStamp: null, world: 0,
    };
    const decision = decideToolExecution(call('2', 'exec_shell', { command: 'git status' }), state([first]));

    assert.deepEqual(decision, { kind: 'EXECUTE' }, 'the workspace may be the same, but the command\'s output can change');
  });
});
