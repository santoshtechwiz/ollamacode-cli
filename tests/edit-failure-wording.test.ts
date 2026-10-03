import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentState } from '../src/agent/state';
import { applyApprovalPolicy } from '../src/tool/policy/permission-policy';
import { renderToolResult } from '../src/agent/router/render';

test('a failed edit tells the person what happened; how to retry goes only to the model', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-edit-'));
  try {
    fs.writeFileSync(path.join(cwd, 'main.tf'), 'thumbprint_list = ["abc"]\n');
    const state: any = createWorkspaceState(cwd);
    state.permissions = createAgentState().permissions;
    applyApprovalPolicy(state, { yes: true });
    const executor = createExecutor({ root: cwd, state, timeoutMs: 20_000 });
    const { result } = await executor.run('edit_file', { path: 'main.tf', edits: [{ search: 'thumbprint_list = ["xyz"]', replace: 'x' }] }, {});

    assert.equal(result.ok, false);
    assert.match(String(result.error), /Edit 1 of 1 failed: .*\nNothing was written/s);
    assert.doesNotMatch(String(result.error), /resend the whole array/, 'the person is not told how the model should retry');
    assert.match(String(result.hint), /Fix item 1 and resend the whole array/);
    assert.match(renderToolResult(result, 'edit_file'), /Hint: .*resend the whole array/, 'the model still reads it');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
