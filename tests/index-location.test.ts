// The workspace index lives inside .ollamacode/; the old .agent/ copy is cleared without touching other tools' files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { clearWorkspaceIndex, openWorkspaceIndex } from '../src/context/workspace-index/open';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-index-loc-'));

describe('workspace index location', () => {
  it('opens under .ollamacode/index, and clearing it leaves .agent/ alone', async () => {
    const root = tmp();
    try {
      fs.writeFileSync(path.join(root, 'a.js'), 'export const a = 1;\n');
      fs.mkdirSync(path.join(root, '.agent', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(root, '.agent', 'rules', 'style.md'), 'another tool\'s rule');
      const index: any = await openWorkspaceIndex(root);
      await index?.close();
      assert.ok(fs.existsSync(path.join(root, '.ollamacode', 'index', 'workspace.db')));
      await clearWorkspaceIndex(root);
      assert.equal(fs.readFileSync(path.join(root, '.agent', 'rules', 'style.md'), 'utf8'), 'another tool\'s rule');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes the old .agent/workspace.db, and the folder only when nothing else is in it', async () => {
    const lone = tmp();
    const shared = tmp();
    try {
      for (const root of [lone, shared]) {
        fs.mkdirSync(path.join(root, '.agent'));
        fs.writeFileSync(path.join(root, '.agent', 'workspace.db'), 'old');
      }
      fs.writeFileSync(path.join(shared, '.agent', 'workflow.md'), 'keep');
      for (const root of [lone, shared]) await (await openWorkspaceIndex(root))?.close();
      assert.equal(fs.existsSync(path.join(lone, '.agent')), false, 'only ocode\'s file was there');
      assert.equal(fs.existsSync(path.join(shared, '.agent', 'workspace.db')), false);
      assert.equal(fs.readFileSync(path.join(shared, '.agent', 'workflow.md'), 'utf8'), 'keep');
    } finally {
      fs.rmSync(lone, { recursive: true, force: true });
      fs.rmSync(shared, { recursive: true, force: true });
    }
  });
});
