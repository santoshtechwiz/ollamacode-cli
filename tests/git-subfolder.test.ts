// git in a project subfolder: init there, paths stay workspace-relative, a first commit verifies, ocode's folders stay out.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentState } from '../src/agent/state';
import { applyApprovalPolicy } from '../src/tool/policy/permission-policy';

const AUTHOR = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

function executor(root: string) {
  const state: any = createWorkspaceState(root, { sessionId: `g${Date.now()}` });
  state.permissions = createAgentState().permissions;
  applyApprovalPolicy(state, { yes: true });
  return createExecutor({ root, state });
}

describe('git in a project subfolder', () => {
  // The commits need an author; what the environment held before is put back after.
  const saved: Record<string, string | undefined> = {};
  before(() => {
    for (const [k, v] of Object.entries(AUTHOR)) { saved[k] = process.env[k]; process.env[k] = v; }
  });
  after(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it('initialises the repository there, commits with workspace-relative paths, and the first commit is verified', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-git-'));
    try {
      fs.mkdirSync(path.join(root, 'todo-app'));
      fs.writeFileSync(path.join(root, 'todo-app', 'index.js'), 'console.log(1);\n');
      fs.mkdirSync(path.join(root, 'todo-app', '.ollamacode', 'index'), { recursive: true });
      fs.writeFileSync(path.join(root, 'todo-app', '.ollamacode', 'index', 'workspace.db'), 'x');
      const ex = executor(root);

      const init: any = (await ex.run('git', { operation: 'init', cwd: 'todo-app' })).result;
      assert.equal(init.ok, true, init.error);
      assert.ok(fs.existsSync(path.join(root, 'todo-app', '.git')), 'the repository is in the project folder');
      assert.equal(fs.existsSync(path.join(root, '.git')), false, 'not in the workspace root');
      assert.match(fs.readFileSync(path.join(root, 'todo-app', '.git', 'info', 'exclude'), 'utf8'), /^\.ollamacode\/$/m);

      const add: any = (await ex.run('git', { operation: 'add', cwd: 'todo-app', paths: 'todo-app/index.js' })).result;
      assert.equal(add.ok, true, add.error);
      const commit: any = (await ex.run('git', { operation: 'commit', cwd: 'todo-app', message: 'first' })).result;
      assert.equal(commit.ok, true, commit.error);
      assert.match(commit.display, /first commit in this repository/);
      const tracked = execFileSync('git', ['ls-files'], { cwd: path.join(root, 'todo-app'), encoding: 'utf8' }).trim();
      assert.equal(tracked, 'index.js', 'ocode\'s index stays out of the repository');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks paths as status names them when the repository sits above cwd', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-git-up-'));
    try {
      fs.mkdirSync(path.join(root, 'todo-app'));
      fs.writeFileSync(path.join(root, 'todo-app', 'a.js'), 'one\n');
      execFileSync('git', ['init', '-q'], { cwd: root });
      execFileSync('git', ['add', '-A'], { cwd: root });
      execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
      const ex = executor(root);

      fs.writeFileSync(path.join(root, 'todo-app', 'a.js'), 'two\n');
      const add: any = (await ex.run('git', { operation: 'add', cwd: 'todo-app', paths: 'todo-app/a.js' })).result;
      assert.equal(add.ok, true, add.error);
      assert.doesNotMatch(String(add.display), /no changes to stage/, 'the staged file is found in status');

      const unstage: any = (await ex.run('git', { operation: 'restore', cwd: 'todo-app', staged: true, paths: 'todo-app/a.js' })).result;
      assert.equal(unstage.ok, true, unstage.error);
      const restore: any = (await ex.run('git', { operation: 'restore', cwd: 'todo-app', paths: 'todo-app/a.js' }, { approve: async () => true } as any)).result;
      assert.equal(restore.ok, true, restore.error);
      assert.equal(fs.readFileSync(path.join(root, 'todo-app', 'a.js'), 'utf8'), 'one\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
