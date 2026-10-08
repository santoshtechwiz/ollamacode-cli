// From a session that built a React landing page: valid JSX was refused as a syntax error until the model gave up, and
// a scaffold's App.css was deleted without being read.
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
import { syntaxBreak } from '../src/tool/filesystem/_syntax';

describe('syntax check for JavaScript and TypeScript', () => {
  it('accepts what the TypeScript compiler accepts, such as a bare & in JSX text', async () => {
    assert.equal(await syntaxBreak('src/App.tsx', '', 'export const Logo = () => <div>☕ <span className="ml-2">Bean & Brew</span></div>;\n'), null);
    assert.equal(await syntaxBreak('src/App.jsx', '', 'export const Menu = () => <p>Tea & Cake</p>;\n'), null);
    assert.equal(await syntaxBreak('src/id.ts', '', 'export const id = <T,>(x: T) => x;\n'), null);
  });

  it('still refuses a real syntax error, naming its line', async () => {
    const broken = await syntaxBreak('src/App.tsx', 'export const A = 1;\n', 'export const A = 1;\nexport const B = () => <div>{</div>;\n');
    assert.match(String(broken?.why), /syntax error at line 2/);
    assert.match(String((await syntaxBreak('src/a.ts', '', 'const x: = 1;\n'))?.why), /syntax error at line 1/);
  });
});

describe('delete_file and files it has not read', () => {
  function workspace() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-del-'));
    fs.mkdirSync(path.join(cwd, 'src'));
    fs.writeFileSync(path.join(cwd, 'src/App.css'), '.logo { height: 6em; }\n');
    fs.writeFileSync(path.join(cwd, 'src/empty.css'), '\n');
    fs.writeFileSync(path.join(cwd, 'src/logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    const state: any = createWorkspaceState(cwd, { sessionId: `t${Date.now()}` });
    state.permissions = createAgentState().permissions;
    applyApprovalPolicy(state, { yes: true });
    return { cwd, ex: createExecutor({ root: cwd, state }) };
  }

  it('refuses a text file with content until it has been read, then deletes it', async () => {
    const w = workspace();
    try {
      const refused: any = (await w.ex.run('delete_file', { path: 'src/App.css' })).result;
      assert.equal(refused.ok, false);
      assert.match(refused.error, /src\/App\.css has not been read in this session — nothing was deleted/);
      assert.match(refused.hint, /no longer needed can stay/);
      assert.equal(fs.existsSync(path.join(w.cwd, 'src/App.css')), true);

      assert.equal(((await w.ex.run('read_file', { path: 'src/App.css' })).result as any).ok, true);
      const deleted: any = (await w.ex.run('delete_file', { path: 'src/App.css' })).result;
      assert.equal(deleted.ok, true, deleted.error);
      assert.equal(fs.existsSync(path.join(w.cwd, 'src/App.css')), false);
    } finally {
      fs.rmSync(w.cwd, { recursive: true, force: true });
    }
  });

  it('lets an empty file or a binary file go without a read', async () => {
    const w = workspace();
    try {
      for (const rel of ['src/empty.css', 'src/logo.png']) {
        const r: any = (await w.ex.run('delete_file', { path: rel })).result;
        assert.equal(r.ok, true, `${rel}: ${r.error}`);
      }
    } finally {
      fs.rmSync(w.cwd, { recursive: true, force: true });
    }
  });
});
