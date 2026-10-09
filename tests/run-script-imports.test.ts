// run_script imports what the project at its cwd has: a session's script could not import the project's lucide-react,
// because the script file sat in the OS temp folder and Node resolves imports from the file's own folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import '../src/tool/index.ts';
import { ToolExecutor } from '../src/tool/core/tool-runtime';

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-script-imports-'));
  const pkg = path.join(root, 'site', 'node_modules', 'icons');
  fs.mkdirSync(pkg, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'icons', type: 'module', exports: './index.js' }));
  fs.writeFileSync(path.join(pkg, 'index.js'), "export const Mail = 'mail';\n");
  fs.writeFileSync(path.join(root, 'site', 'package.json'), '{}');
  fs.mkdirSync(path.join(root, 'api'));
  fs.writeFileSync(path.join(root, 'api', 'helpers.py'), 'def greet():\n    return "hi"\n');
  return root;
}

const run = (root: string, args: Record<string, unknown>) => new ToolExecutor({ root, state: { autoFixAuthorized: true } }).run('run_script', args);

describe('run_script and the project at its cwd', () => {
  it('a JavaScript script imports the project\'s packages, and leaves nothing behind', async () => {
    const root = workspace();
    try {
      const { result } = await run(root, { cwd: 'site', code: "import * as icons from 'icons';\nconsole.log(Object.keys(icons).join(','));" });
      assert.equal(result.ok, true, String(result.display ?? result.error));
      assert.equal(String((result.data as any).stdout).trim(), 'Mail');
      assert.deepEqual(fs.readdirSync(path.join(root, 'site', 'node_modules', '.cache')), [], 'the script is removed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a script where there is no node_modules still runs, from the temp folder', async () => {
    const root = workspace();
    try {
      const { result } = await run(root, { cwd: 'api', code: "console.log('ok');" });
      assert.equal(result.ok, true, String(result.display ?? result.error));
      assert.equal(fs.existsSync(path.join(root, 'api', 'node_modules')), false, 'no node_modules is made');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const python = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
  it('a Python script imports the project\'s own modules', { skip: python ? false : 'no python' }, async () => {
    const root = workspace();
    try {
      const { result } = await run(root, { cwd: 'api', language: 'python', code: 'import helpers\nprint(helpers.greet())' });
      assert.equal(result.ok, true, String(result.display ?? result.error));
      assert.equal(String((result.data as any).stdout).trim(), 'hi');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
