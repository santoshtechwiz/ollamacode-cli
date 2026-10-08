// read_file counts a file's lines as an editor does: a final newline ends the last line, it does not start another.
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

function workspace(text: string) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-lines-'));
  fs.writeFileSync(path.join(cwd, '.gitignore'), text);
  const state: any = createWorkspaceState(cwd);
  state.permissions = createAgentState().permissions;
  applyApprovalPolicy(state, { yes: true });
  return { cwd, ex: createExecutor({ root: cwd, state }), read: () => fs.readFileSync(path.join(cwd, '.gitignore'), 'utf8') };
}

describe('read_file line counting', () => {
  it('a final newline is not shown as an extra, empty line', async () => {
    const w = workspace('node_modules/\nbin/\n.agent/\n');
    try {
      const r: any = (await w.ex.run('read_file', { path: '.gitignore' })).result;
      assert.equal(r.data.lines, 3);
      assert.equal(String(r.display).split('\n').length, 3, String(r.display));
      assert.equal(r.data.fullContent, 'node_modules/\nbin/\n.agent/\n', 'the text itself is unchanged');
    } finally {
      fs.rmSync(w.cwd, { recursive: true, force: true });
    }
  });

});

