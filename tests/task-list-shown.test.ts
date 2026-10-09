import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createWorkspaceState, describeSession } from '../src/context/workspace-state';

const LIST = [
  { content: 'Implement the Result pattern', status: 'completed' as const },
  { content: 'Validate configuration on start', status: 'in_progress' as const },
  { content: 'Test UserService', status: 'pending' as const },
];

describe('the task list', () => {

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
