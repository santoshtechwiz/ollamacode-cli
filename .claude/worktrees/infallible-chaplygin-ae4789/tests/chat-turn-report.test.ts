import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reportChatTurn } from '../src/cli/chat/turn/index';
import { STOP_REASONS } from '../src/protocol';
import { BackgroundInbox } from '../src/tool/process/background-inbox';

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
  it('a reply cut off at its limit names the limit, what landed, and /continue', async () => {
    const { host: h, notes } = host({ maxTokens: 2048, thinkingEnabled: true, state: { changes: [{ path: 'go-curl/storage.go' }] } });
    await reportChatTurn(h, { content: '', toolResults: [okCall('write_file')], iterations: 3, stopReason: STOP_REASONS.OUTPUT_TRUNCATED } as any, {});
    assert.ok(notes.includes("The model's reply was cut off at its 2,048-token limit (thinking counts toward it). 1 file change already landed. Type /continue to pick up where it stopped, or raise agent.maxTokens."), notes.join(' | '));
  });

  it('a turn that ends while the job it started still runs says it is waiting, once, not that it is stuck', async () => {
    const background = new BackgroundInbox();
    background.watching({ id: 'go-run', command: 'go run main.go' });
    const { host: h, notes } = host({ state: { background } });
    const job = { name: 'exec_shell', args: {}, result: { ok: true, kind: 'command', data: { id: 'go-run', background: true } } };
    await reportChatTurn(
      h,
      { content: '', toolResults: [job, okCall('subprocess_status'), okCall('subprocess_status')], iterations: 3, stopReason: STOP_REASONS.GUARD_STUCK } as any,
      {},
    );
    assert.deepEqual(notes, ['Waiting for "go-run" — still running in the background; its result will show here when it ends, no need to type anything.']);
  });

  it('once that job has ended, a silent turn is reported as before', async () => {
    const background = new BackgroundInbox();
    background.watching({ id: 'go-run', command: 'go run main.go' });
    background.record({ id: 'go-run', command: 'go run main.go', outcome: 'finished', exitCode: 0, signal: null, durationMs: 1000 } as any);
    const { host: h, notes } = host({ state: { background } });
    const job = { name: 'exec_shell', args: {}, result: { ok: true, kind: 'command', data: { id: 'go-run', background: true } } };
    await reportChatTurn(h, { content: '', toolResults: [job], iterations: 1, stopReason: STOP_REASONS.GUARD_STUCK } as any, {});
    assert.ok(!notes.some((n) => /Waiting for/.test(n)), notes.join(' / '));
  });

  it('a stuck turn with no answer says so in one line that also carries what ran', async () => {
    const { host: h, notes } = host();
    await reportChatTurn(h, { content: '', toolResults: [okCall('list_directory'), okCall('list_directory')], iterations: 3, stopReason: STOP_REASONS.GUARD_STUCK } as any, {});
    assert.equal(notes.length, 1, notes.join(' | '));
    assert.match(notes[0], /^Paused — .* gave no answer\. It ran: .*2 of 2 steps worked\. Tell it what to do next/);
  });

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
      notes.some((note) => note.includes('gave no answer') && note.includes('2 of 2 steps worked')),
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
      notes.some((note) => note.includes('gave no answer') && note.includes('1 failed')),
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

    assert.ok(notes.some((note) => note.includes('1 of 1 step worked')), `should report the run that succeeded: ${notes.join(' | ')}`);
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
