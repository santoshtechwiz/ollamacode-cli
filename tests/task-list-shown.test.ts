import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { reportChatTurn } from '../src/cli/chat/turn/index';
import { createWorkspaceState, describeSession } from '../src/context/workspace-state';
import { STOP_REASONS } from '../src/protocol';

const LIST = [
  { content: 'Implement the Result pattern', status: 'completed' as const },
  { content: 'Validate configuration on start', status: 'in_progress' as const },
  { content: 'Test UserService', status: 'pending' as const },
];

describe('the task list', () => {
  it('a turn that never rewrote the list still ends with it shown, and an unfinished one stays', async () => {
    const committed: unknown[] = [];
    const state: any = { todos: LIST };
    const host: any = {
      render: { text: '', markdown: () => {}, note: () => {}, commitTasks: (list: unknown) => committed.push(list) },
      workspace: { state },
      interactive: false,
      flags: {},
    };
    await reportChatTurn(host, { content: 'Two left.', toolResults: [], iterations: 2, stopReason: STOP_REASONS.COMPLETE } as any, {});
    assert.deepEqual(committed, [[
      { title: 'Implement the Result pattern', status: 'done' },
      { title: 'Validate configuration on start', status: 'active' },
      { title: 'Test UserService', status: 'open' },
    ]]);
    assert.equal(state.todos, LIST);
  });

  it('a later turn that left the list as it was does not print it again; a rewrite does', async () => {
    const committed: unknown[] = [];
    const state: any = { todos: LIST };
    const host: any = {
      render: { text: '', markdown: () => {}, note: () => {}, commitTasks: (list: unknown) => committed.push(list) },
      workspace: { state },
      interactive: false,
      flags: {},
    };
    const turn = () => reportChatTurn(host, { content: 'ok', toolResults: [], iterations: 1, stopReason: STOP_REASONS.COMPLETE } as any, {});
    await turn();
    await turn();
    assert.equal(committed.length, 1, 'the untouched list is not printed a second time');
    state.todos = LIST.map((t) => ({ ...t, status: 'completed' as const }));
    await turn();
    assert.equal(committed.length, 2, 'the rewritten list is');
  });

  it('the session record shows the model its list every request', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-todos-'));
    try {
      const state: any = createWorkspaceState(cwd);
      state.todos = LIST;
      assert.match(describeSession(state), /Your task list.*\n\[x\] Implement the Result pattern\n\[~\] Validate configuration on start\n\[ \] Test UserService/);
      state.reset?.();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
