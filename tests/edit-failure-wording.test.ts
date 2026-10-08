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

test('a search that parts ways at a line shows that line, marked, and does not guess elsewhere', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-edit-'));
  try {
    const lines = ['const a = 1;', '', 'class M {', '  constructor() {', '    this.items = [];', '  }', '', '  findAll() {', '    return this.items;', '  }',
      ...Array.from({ length: 30 }, (_, i) => `  m${i}() { return ${i}; }`), '}', ''];
    fs.writeFileSync(path.join(cwd, 'm.js'), lines.join('\n'));
    const state: any = createWorkspaceState(cwd);
    state.permissions = createAgentState().permissions;
    applyApprovalPolicy(state, { yes: true });
    const executor = createExecutor({ root: cwd, state, timeoutMs: 20_000 });
    const search = lines.slice(0, 20).join('\n').replace('findAll() {', 'getAll() {');
    await executor.run('read_file', { path: 'm.js' }, {});
    const { result } = await executor.run('edit_file', { path: 'm.js', search, replace: 'x' }, {});

    assert.match(String(result.error), /differs at line 8: the file has “findAll\(\) \{” where the search has “getAll\(\) \{”/);
    assert.match(String(result.display), /^> +8: {3}findAll\(\) \{$/m, 'the listing shows the line the error names, marked');
    assert.doesNotMatch(String(result.hint), /Did you mean/, 'no second guess at where the search was meant to go');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
