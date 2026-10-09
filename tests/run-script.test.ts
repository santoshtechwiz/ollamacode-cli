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
