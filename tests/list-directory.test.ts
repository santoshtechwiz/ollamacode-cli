// list_directory shows a small folder's subfolders with it, so a project is one call, and never grows past its budget.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';

function workspace(files: string[]): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-ls-'));
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x');
  }
  return root;
}

async function list(root: string, rel: string): Promise<any> {
  return (await createExecutor({ root, state: createWorkspaceState(root) }).run('list_directory', { path: rel })).result;
}

describe('list_directory', () => {
  it('lists a small project whole, subfolders indented under their folder', async () => {
    const root = workspace(['App/Program.cs', 'App/Domain/User.cs', 'App/Domain/Common/Result.cs', 'App/Services/Interfaces/IUserService.cs', 'App/node_modules/x/index.js']);
    try {
      const r = await list(root, 'App');
      const lines = String(r.display).split('\n');
      assert.match(lines[0], /^App — 1 file, 2 directories; 4 files in all, subfolders listed below:$/);
      assert.ok(lines.includes('Domain/') && lines.includes('  Common/') && lines.includes('    Result.cs (1B)'), lines.join('\n'));
      assert.ok(lines.includes('    IUserService.cs (1B)'), lines.join('\n'));
      assert.ok(!lines.some((l) => /index\.js/.test(l)), 'vendor folders are never opened');
      assert.deepEqual(r.data.entries.map((e: any) => e.name), ['Domain', 'Services', 'Program.cs'], 'data lists the folder itself, as before');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
