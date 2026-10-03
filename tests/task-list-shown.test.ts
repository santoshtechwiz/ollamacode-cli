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

describe("the task's own list", () => {
  it('a /continue turn that never rewrote the list still ends with it shown', async () => {
    const committed: unknown[] = [];
    const host: any = {
      render: { text: '', markdown: () => {}, note: () => {}, plan: () => {}, commitTasks: (list: unknown) => committed.push(list) },
      workspace: { state: { autoFixAuthorized: true, todos: LIST, todosTask: 'task-1', taskId: 'task-1' } },
      interactive: false,
      flags: {},
    };
    await reportChatTurn(host, { content: 'All three steps are done.', toolResults: [], iterations: 2, stopReason: STOP_REASONS.COMPLETE } as any, {});
    assert.deepEqual(committed, [[
      { title: 'Implement the Result pattern', text: 'Implement the Result pattern', status: 'done' },
      { title: 'Validate configuration on start', text: 'Validate configuration on start', status: 'active' },
      { title: 'Test UserService', text: 'Test UserService', status: 'open' },
    ]]);
  });

  it("a list another task left behind is not shown as this one's", async () => {
    const committed: unknown[] = [];
    const host: any = {
      render: { text: '', markdown: () => {}, note: () => {}, plan: () => {}, commitTasks: (list: unknown) => committed.push(list) },
      workspace: { state: { autoFixAuthorized: true, todos: LIST, todosTask: 'task-1', taskId: 'task-2' } },
      interactive: false,
      flags: {},
    };
    await reportChatTurn(host, { content: 'Hello.', toolResults: [], iterations: 1, stopReason: STOP_REASONS.COMPLETE } as any, {});
    assert.deepEqual(committed, []);
  });

  it('the session record shows the model its list as it last wrote it, every request', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-todos-'));
    try {
      const state: any = createWorkspaceState(cwd);
      state.taskId = 'task-1';
      state.todos = LIST;
      state.todosTask = 'task-1';
      const record = describeSession(state);
      assert.match(record, /Your task list, as you last wrote it.*\n\[x\] Implement the Result pattern\n\[~\] Validate configuration on start\n\[ \] Test UserService/);
      state.taskId = 'task-2';
      assert.doesNotMatch(describeSession(state), /task list/, "another task's list is not in this one's record");
      state.reset?.();
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
