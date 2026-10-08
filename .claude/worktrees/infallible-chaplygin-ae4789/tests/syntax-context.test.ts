// An edit refused for breaking the code shows the model the would-be file around the error, not only a line number.
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
import { renderToolResult } from '../src/agent/router/render';
import { describeToolResult } from '../src/ui/tool-preview';

const app = [
  "const express = require('express');",
  'const app = express();',
  "app.post('/todos', (req, res) => {",
  '  const { title } = req.body;',
  '  res.status(201).json({ title });',
  '});',
  '',
].join('\n');

describe('an edit that would break the code', () => {
  it('shows the model what the file would look like around the error, and keeps the screen to one line', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-syntax-'));
    try {
      fs.writeFileSync(path.join(cwd, 'index.js'), app);
      const state: any = createWorkspaceState(cwd, { sessionId: `s${Date.now()}` });
      state.permissions = createAgentState().permissions;
      applyApprovalPolicy(state, { yes: true });
      const ex = createExecutor({ root: cwd, state });
      await ex.run('read_file', { path: 'index.js' });
      // The first line only as search, a whole handler as replace: the old body is left behind.
      const r: any = (await ex.run('edit_file', {
        path: 'index.js',
        search: "app.post('/todos', (req, res) => {",
        replace: "app.post('/todos', (req, res) => {\n  res.status(201).json({});\n});",
      })).result;
      assert.equal(r.ok, false);
      const seen = renderToolResult(r, 'edit_file');
      assert.match(seen, /would look like around line \d+ after this edit/);
      assert.match(seen, /const \{ title \} = req\.body;/, 'the left-behind old body is in view');
      assert.match(seen, /^>\s+\d+\t\}\);$/m, 'the error line is marked');
      assert.match(String(r.hint), /search names only the start of a block/);
      assert.equal(fs.readFileSync(path.join(cwd, 'index.js'), 'utf8'), app, 'nothing written');
      assert.doesNotMatch(describeToolResult('edit_file', r).detail.join('\n'), /would look like/, 'the snippet is for the model, not the screen');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
