import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';
import '../src/tool/index.ts';
import { ToolExecutor } from '../src/tool/core/tool-runtime';
import { PermissionPolicy, createPermissions } from '../src/tool/policy/permission-policy';
import { TOOL_META } from '../src/tool/index';
import { TOOL_ERROR_CODE } from '../src/protocol';
import { spawnSync } from 'node:child_process';

let root: string;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-run-script-ws-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), "import { ToolExecutor } from './x.ts';\n");
  fs.writeFileSync(path.join(root, 'src', 'b.ts'), "export const b = 1;\n");
  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ name: 'demo', deps: { a: '1', b: '2' } }));
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const listing = () => fs.readdirSync(root, { recursive: true }).map(String).sort();

/** An executor whose session pre-approves risky calls, like `--yes` or permissions risky=always. */
function approvedExecutor() {
  return new ToolExecutor({ root, state: { autoFixAuthorized: true } });
}

describe('run_script', () => {
  it('runs JavaScript by default and returns stdout, stderr, exitCode, durationMs, timedOut', async () => {
    const before = listing();
    const { result } = await approvedExecutor().run('run_script', {
      code: [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        'const files = [];',
        "for (const name of await fs.readdir('src')) {",
        "  const text = await fs.readFile(path.join('src', name), 'utf8');",
        '  if (/import.*ToolExecutor/.test(text)) files.push(name);',
        '}',
        'console.log(files.join(","));',
        "console.error('note');",
      ].join('\n'),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.language, 'javascript');
    assert.equal(result.data.stdout.trim(), 'a.ts');
    assert.match(result.data.stderr, /note/);
    assert.equal(result.data.exitCode, 0);
    assert.equal(result.data.timedOut, false);
    assert.equal(typeof result.data.durationMs, 'number');
    assert.ok(!result.data.scriptPath.startsWith(root), 'script must live outside the workspace');
    assert.equal(fs.existsSync(result.data.scriptPath), false, 'script must be deleted');
    assert.deepEqual(listing(), before, 'nothing may be written into the workspace');
  });

  it('runs TypeScript through the bundled tsx and passes args and OCODE_ROOT', async () => {
    const { result } = await approvedExecutor().run('run_script', {
      language: 'typescript',
      code: "import { readFileSync } from 'node:fs';\nconst cfg: { deps: Record<string, string> } = JSON.parse(readFileSync(`${process.env.OCODE_ROOT}/config.json`, 'utf8'));\nconsole.log(Object.keys(cfg.deps).length, process.argv.slice(2).join('+'));",
      args: ['x', 'y'],
    });
    assert.equal(result.ok, true, result.error ?? result.display);
    assert.equal(result.data.stdout.trim(), '2 x+y');
  });

  it('reports a non-zero exit as EEXIT and still deletes the script', async () => {
    const { result } = await approvedExecutor().run('run_script', { code: "console.error('boom'); process.exit(3);" });
    assert.equal(result.ok, false);
    assert.equal(result.code, TOOL_ERROR_CODE.EEXIT);
    assert.equal(result.data.exitCode, 3);
    assert.match(result.display ?? '', /boom/);
    assert.equal(fs.existsSync(result.data.scriptPath), false);
  });

  it('stops a script at the timeout, reports timedOut, and deletes it', async () => {
    const { result } = await approvedExecutor().run('run_script', { code: 'setInterval(() => {}, 1000);', timeout_ms: 5000 });
    assert.equal(result.ok, false);
    assert.equal(result.code, TOOL_ERROR_CODE.ETIMEDOUT);
    assert.equal(result.data.timedOut, true);
    assert.equal(fs.existsSync(result.data.scriptPath), false);
  });

  it('runs in a workspace-relative cwd and refuses one that does not exist', async () => {
    const ok = await approvedExecutor().run('run_script', { code: 'console.log(process.cwd())', cwd: 'src' });
    assert.equal(ok.result.ok, true);
    assert.equal(fs.realpathSync(ok.result.data.stdout.trim()), fs.realpathSync(path.join(root, 'src')));

    const missing = await approvedExecutor().run('run_script', { code: 'console.log(1)', cwd: 'nope' });
    assert.equal(missing.result.ok, false);
  });
});

describe('run_script permissions', () => {
  const decide = (policy: 'ask' | 'always' | 'never', interactive = true) =>
    new PermissionPolicy().decide({
      toolName: 'run_script',
      args: { code: 'console.log(1)' },
      toolDef: TOOL_META.run_script,
      cwd: root,
      root,
      permissions: createPermissions(),
      yes: false,
      policy,
      interactive,
    });

  it('follows the session policy ask | always | never', async () => {
    assert.equal(await decide('ask'), 'ask');
    assert.equal(await decide('always'), 'allow');
    assert.equal(await decide('never'), 'deny');
    assert.equal(await decide('ask', false), 'deny');
  });

  it('asks through the executor and does not run when declined or unanswerable', async () => {
    let asked = 0;
    const declined = await new ToolExecutor({ root, state: {}, approve: async () => { asked++; return false; } })
      .run('run_script', { code: 'console.log(1)' });
    assert.equal(asked, 1);
    assert.equal(declined.result.ok, false);
    assert.equal(declined.result.code, TOOL_ERROR_CODE.EDENIED);

    const noHandler = await new ToolExecutor({ root, state: {} }).run('run_script', { code: 'console.log(1)' });
    assert.equal(noHandler.result.code, TOOL_ERROR_CODE.EDENIED);
  });
});

describe('run-script-imports', () => {
  // run_script imports what the project at its cwd has: a session's script could not import the project's lucide-react,
  // because the script file sat in the OS temp folder and Node resolves imports from the file's own folder.
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
});
