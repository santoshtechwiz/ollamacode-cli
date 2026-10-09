import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe, it } from 'node:test';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentState } from '../src/agent/state';
import { applyApprovalPolicy } from '../src/tool/policy/permission-policy';
import { dryRunEdit } from '../src/tool/filesystem/edit-file.tool';
import { renderToolResult } from '../src/agent/router/render';
import { describeToolResult } from '../src/ui/tool-preview';
import fsp from 'node:fs/promises';
import writeFile from '../src/tool/filesystem/write-file.tool';

describe('edit-failure-wording', () => {
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
});

describe('edit-json-indent', () => {
  describe('edit_file on JSON writes the replacement as given', () => {
    it('keeps nested indentation instead of flattening it to the file unit', () => {
      const before = '{\n  "a": {\n    "x": 1\n  }\n}\n';
      const out = dryRunEdit(before, { path: 'p.json', search: '"x": 1', replace: '"x": 1,\n    "y": {\n      "z": 2\n    }' }, 'p.json', true);
      assert.equal(out.status, 'ok');
      assert.equal((out as any).content, '{\n  "a": {\n    "x": 1,\n    "y": {\n      "z": 2\n    }\n  }\n}\n');
    });

    it('still matches a search whose indentation differs, and still refuses invalid JSON', () => {
      const before = '{\n  "a": 1,\n  "b": 2\n}\n';
      assert.equal(dryRunEdit(before, { path: 'p.json', search: '"a": 1,\n"b": 2', replace: '"a": 1,\n  "b": 3' }, 'p.json', true).status, 'ok');
      assert.equal(dryRunEdit(before, { path: 'p.json', search: '"b": 2', replace: '"b": ' }, 'p.json', true).status, 'fail');
    });
  });
});

describe('read-edit-lines', () => {
  // read_file counts a file's lines as an editor does: a final newline ends the last line, it does not start another.
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
});

describe('syntax-context', () => {
  // An edit refused for breaking the code shows the model the would-be file around the error, not only a line number.
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
});

describe('write-file-world', () => {
  async function ctxFor(root: string) {
    const changes: Array<{ op: string; rel: string; type: string }> = [];
    const ctx = {
      root,
      ws: { rel: (abs: string) => path.relative(root, abs).split(path.sep).join('/') },
      state: {
        note(op: string, rel: string, type: string) {
          changes.push({ op, rel, type });
        },
      },
    } as any;
    return { ctx, changes };
  }

  test('rewriting identical content does not advance the world', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wf-'));
    try {
      const file = path.join(root, 'same.txt');
      await fsp.writeFile(file, 'stable\n', 'utf8');
      const { ctx, changes } = await ctxFor(root);

      const result = await writeFile.execute({ path: file, content: 'stable\n' } as any, ctx);

      assert.equal(result.ok, true);
      // The bytes on disk are unchanged, so the workspace did not move. Recording a change here
      // would advance the world and make this same write look like fresh work next time.
      assert.equal(changes.length, 0, 'a no-op write must not record a change');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });

  test('rewriting different content advances the world', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'wf-'));
    try {
      const file = path.join(root, 'changed.txt');
      await fsp.writeFile(file, 'before\n', 'utf8');
      const { ctx, changes } = await ctxFor(root);

      const result = await writeFile.execute({ path: file, content: 'after\n' } as any, ctx);

      assert.equal(result.ok, true);
      assert.equal(changes.length, 1);
      assert.equal(changes[0].op, 'overwrite');
    } finally {
      await fsp.rm(root, { recursive: true, force: true });
    }
  });
});

describe('undoable-delete', () => {
  // Deletes are saved first: /undo brings back a deleted file or a whole deleted folder, and the prompt says so.
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
});
