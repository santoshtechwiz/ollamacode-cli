import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reportChatTurn } from '../src/cli/chat/turn/index';
import { STOP_REASONS } from '../src/protocol';

function okCall(name: string) {
  return {
    name,
    args: {},
    result: { ok: true, kind: 'text' },
  };
}

function failedCall(name: string) {
  return {
    name,
    args: {},
    result: { ok: false, kind: 'text', code: 'EIO' },
  };
}

function host(workspace: Record<string, unknown> = {}) {
  const markdown: string[] = [];
  const notes: string[] = [];

  return {
    host: {
      render: {
        text: '',
        markdown: (content: string) => {
          markdown.push(content);
        },
        note: (message: string) => {
          notes.push(message);
        },
      },
      workspace,
    } as any,
    markdown,
    notes,
  };
}

describe('reportChatTurn', () => {
  it('never claims "Done" for a turn the model did not answer, however many calls succeeded', async () => {
    const { host: h, markdown, notes } = host();

    const code = await reportChatTurn(
      h,
      {
        content: '',
        toolResults: [
          okCall('list_directory'),
          okCall('list_directory'),
        ],
        iterations: 3,
        stopReason: STOP_REASONS.GUARD_STUCK,
      } as any,
      {},
    );

    assert.equal(code, 1);
    assert.equal(markdown.length, 0, `claimed an answer the model never gave: ${markdown.join(' | ')}`);
    assert.ok(
      notes.some((note) => note.includes('finished without saying what it did') && note.includes('2 of 2 steps worked')),
      `lost the record of what ran: ${notes.join(' | ')}`,
    );
    assert.ok(
      notes.some((note) => note.startsWith('Paused —')),
      `hid why the turn stopped: ${notes.join(' | ')}`,
    );
  });

  it('keeps the old messages when calls failed or were refused', async () => {
    const { host: h, markdown, notes } = host();

    await reportChatTurn(
      h,
      {
        content: '',
        toolResults: [okCall('write_file'), failedCall('exec_shell')],
        iterations: 2,
        stopReason: STOP_REASONS.GUARD_STUCK,
      } as any,
      {},
    );

    assert.equal(markdown.length, 0);
    assert.ok(
      notes.some((note) => note.includes('finished without saying what it did')),
      `lost the failure report: ${notes.join(' | ')}`,
    );
    assert.ok(
      notes.some((note) => note.startsWith('Paused —')),
      `lost the stuck report: ${notes.join(' | ')}`,
    );
  });

  it('renders the model answer when there is one', async () => {
    const { host: h, markdown } = host();

    const code = await reportChatTurn(
      h,
      {
        content: 'All done.',
        toolResults: [okCall('write_file')],
        iterations: 1,
        stopReason: STOP_REASONS.COMPLETE,
      } as any,
      {},
    );

    assert.equal(code, 0);
    assert.deepEqual(markdown, ['All done.']);
  });

  it('does not report a task list an earlier turn left behind', async () => {
    // state.todos outlives the turn, so naming it as this turn's work would send the
    // person off to finish someone else's list.
    const { host: h, markdown, notes } = host({
      state: {
        todos: [
          { content: 'stale step from an earlier turn', status: 'pending' },
          { content: 'another stale step', status: 'in_progress' },
        ],
      },
    });

    await reportChatTurn(
      h,
      {
        content: '',
        toolResults: [okCall('write_file')],
        iterations: 2,
        stopReason: STOP_REASONS.GUARD_STUCK,
      } as any,
      {},
    );

    assert.ok(notes.some((note) => note.includes('finished without saying what it did')), `should report the run that succeeded: ${notes.join(' | ')}`);
    assert.ok(
      notes.every((note) => !note.includes('stale step') && !note.includes('another stale step')),
      `named work this turn never claimed: ${notes.join(' | ')}`,
    );
  });

  it('exits 130 on a cancelled turn without repeating the cancel notice', async () => {
    const { host: h, notes } = host();

    const code = await reportChatTurn(
      h,
      {
        content: 'partial answer',
        toolResults: [],
        iterations: 1,
        stopReason: STOP_REASONS.CANCELLED,
      } as any,
      {},
    );

    assert.equal(code, 130);
    // Ctrl-C and a dismissed prompt already said so where they happened.
    assert.ok(!notes.some((note) => /cancel/i.test(note)), `repeated the cancel notice: ${notes.join(' | ')}`);
  });

  it('asks before reporting the iteration limit', async () => {
    const { host: h, notes } = host();
    const asked: string[] = [];

    const code = await reportChatTurn(
      h,
      {
        content: '',
        toolResults: [okCall('write_file'), failedCall('exec_shell')],
        iterations: 12,
        stopReason: STOP_REASONS.MAX_ITERATIONS,
      } as any,
      {
        confirm: async (message) => {
          asked.push(message);
          return true;
        },
        lastReadFile: { path: 'src/index.ts' },
      },
    );

    assert.equal(code, 1);
    assert.equal(asked.length, 0, 'a question at the end of a turn blocks the prompt');
    assert.ok(
      notes.some((note) => note.includes('took more steps than one turn allows')),
      `lost the limit report: ${notes.join(' | ')}`,
    );
    assert.ok(
      notes.some((note) => note.includes('1 of 2 steps worked') && note.includes('1 failed')),
      `lost the tally: ${notes.join(' | ')}`,
    );
  });

  it('counts the changes that already landed when output was truncated', async () => {
    const { host: h, notes } = host({ state: { changes: [1, 2] } });

    const code = await reportChatTurn(
      h,
      {
        content: '',
        toolResults: [okCall('write_file')],
        iterations: 3,
        stopReason: STOP_REASONS.OUTPUT_TRUNCATED,
      } as any,
      {},
    );

    assert.equal(code, 1);
    assert.ok(
      notes.some((note) => note.includes('2 file changes already landed')),
      `lost the landed changes: ${notes.join(' | ')}`,
    );
  });
});
