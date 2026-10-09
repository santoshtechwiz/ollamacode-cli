// Deletes are saved first: /undo brings back a deleted file or a whole deleted folder, and the prompt says so.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentState } from '../src/agent/state';
import { applyApprovalPolicy } from '../src/tool/policy/permission-policy';

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-undo-'));
  fs.mkdirSync(path.join(cwd, 'app/sub'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'app/main.go'), 'package main\n');
  fs.writeFileSync(path.join(cwd, 'app/sub/util.go'), 'package sub\n');
  const state: any = createWorkspaceState(cwd, { sessionId: `t${Date.now()}` });
  state.permissions = createAgentState().permissions;
  applyApprovalPolicy(state, { yes: true });
  return { cwd, state, ex: createExecutor({ root: cwd, state }) };
}

describe('undoable deletes', () => {
  it('a folder deleted with recursive comes back whole with undo', async () => {
    const w = workspace();
    try {
      const del: any = (await w.ex.run('delete_file', { path: 'app', recursive: true })).result;
      assert.equal(del.ok, true, del.error);
      assert.match(del.display, /2 files saved, \/undo brings it back/);
      assert.equal(fs.existsSync(path.join(w.cwd, 'app')), false);
      const undo: any = (await w.ex.run('undo', {})).result;
      assert.equal(undo.ok, true, undo.error);
      assert.equal(fs.readFileSync(path.join(w.cwd, 'app/main.go'), 'utf8'), 'package main\n');
      assert.equal(fs.readFileSync(path.join(w.cwd, 'app/sub/util.go'), 'utf8'), 'package sub\n');
    } finally {
      fs.rmSync(w.cwd, { recursive: true, force: true });
    }
  });
});
