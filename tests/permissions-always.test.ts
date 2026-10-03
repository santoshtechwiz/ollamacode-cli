import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { defaultRegistry } from '../src/tool/execution/registry';
import { PermissionPolicy } from '../src/tool/policy/permission-policy';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentState } from '../src/agent/state';
import { createApproveFn } from '../src/cli/chat/turn/approval-service';

/** The chat session's real approval path, with the person's answers scripted; counts how often they were asked. */
function session(answers: string[]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-always-'));
  fs.writeFileSync(path.join(cwd, 'job.js'), "console.log('price 123');\n");
  const state: any = createWorkspaceState(cwd);
  const agentState = createAgentState();
  state.permissions = agentState.permissions;
  const asked: string[] = [];
  const host = { workspace: { cwd, root: cwd, state }, agentState, interactive: true, cfg: { permissions: { risky: 'ask' } }, flags: {} } as any;
  const approve = createApproveFn(host, async (_question, call) => {
    asked.push(String(call.args.command));
    return answers.shift() ?? 'no';
  });
  const executor = createExecutor({ root: cwd, state, approve, timeoutMs: 20_000 });
  const start = async (command: string, id: string): Promise<any> => (await executor.run('start_subprocess', { command, id }, {})).result;
  return { cwd, agentState, asked, start, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

describe('"always allow" on starting a process', () => {
  it('is asked once; later starts under any id run without asking', async () => {
    const s = session(['always']);
    try {
      for (const id of ['fetch', 'fetch-2', 'fetch-bg']) {
        const result = await s.start('node job.js', id);
        assert.equal(result.ok, true, `${id}: ${result.error ?? ''}`);
      }
      assert.deepEqual(s.asked, ['node job.js']);
      assert.ok(s.agentState.permissions.alwaysAllowTools.has('start_subprocess'));
    } finally {
      s.cleanup();
    }
  });

  it('still asks before a start whose command deletes files, and does not run it when declined', async () => {
    const s = session(['always', 'no']);
    try {
      await s.start('node job.js', 'first');
      fs.mkdirSync(path.join(s.cwd, 'build'));
      const result = await s.start('rm -rf build', 'clean');
      assert.deepEqual(s.asked, ['node job.js', 'rm -rf build']);
      assert.equal(result.ok, false);
      assert.ok(fs.existsSync(path.join(s.cwd, 'build')), 'the declined delete did not run');
    } finally {
      s.cleanup();
    }
  });

  it('refuses a command the session never runs, whichever tool carries it', async () => {
    const def = defaultRegistry.find('start_subprocess')!;
    const permissions = createAgentState().permissions;
    permissions.alwaysAllowTools.add('start_subprocess');
    const decision = await new PermissionPolicy().decide({
      toolName: 'start_subprocess', args: { command: ':(){ :|:& };:' }, toolDef: def as any,
      cwd: os.tmpdir(), root: os.tmpdir(), permissions, yes: false, policy: 'ask', interactive: true, grantedRoots: [],
    });
    assert.equal(decision, 'deny');
  });
});

describe('the "always" policy (/permissions)', () => {
  const decide = (name: string, args: Record<string, unknown>, interactive: boolean) =>
    new PermissionPolicy().decide({
      toolName: name, args, toolDef: defaultRegistry.find(name) as any,
      cwd: os.tmpdir(), root: os.tmpdir(), permissions: createAgentState().permissions,
      yes: false, policy: 'always', interactive, grantedRoots: [],
    });

  it('approves routine calls without asking', async () => {
    assert.equal(await decide('exec_shell', { command: 'node -v' }, true), 'allow');
    assert.equal(await decide('write_file', { path: 'a.txt', content: 'a' }, true), 'allow');
  });

  it('still asks before a delete when someone is there to answer', async () => {
    assert.equal(await decide('exec_shell', { command: 'rm a.txt' }, true), 'ask');
    assert.equal(await decide('delete_file', { path: 'a.txt' }, true), 'ask');
  });

  it('does not stall a run nobody can answer', async () => {
    assert.equal(await decide('exec_shell', { command: 'rm a.txt' }, false), 'allow');
  });
});

describe('answering "always" once', () => {
  it('covers routine changes of every tool for the session; deletes still ask', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-always-all-'));
    try {
      const state: any = createWorkspaceState(cwd);
      const agentState = createAgentState();
      state.permissions = agentState.permissions;
      const host = { workspace: { cwd, root: cwd, state }, agentState, interactive: true, cfg: { permissions: { risky: 'ask' } }, flags: {} } as any;
      const asked: string[] = [];
      const approve = createApproveFn(host, async (_question, call) => {
        asked.push(call.name);
        return asked.length === 1 ? 'always' : 'yes';
      });
      const executor = createExecutor({ root: cwd, state, approve, timeoutMs: 20_000 });
      const run = async (name: string, args: Record<string, unknown>) => (await executor.run(name, args, {})).result;

      await run('exec_shell', { command: 'node -v' });
      await run('write_file', { path: 'a.txt', content: 'a' });
      await run('edit_file', { path: 'a.txt', old_string: 'a', new_string: 'b' });
      await run('start_subprocess', { command: 'node -v', id: 'p' });
      assert.deepEqual(asked, ['exec_shell'], 'one "always" covered the routine calls of the other tools');

      await run('exec_shell', { command: 'rm a.txt' });
      await run('write_file', { path: 'c.txt', content: 'c' });
      await run('delete_file', { path: 'c.txt' });
      assert.deepEqual(asked, ['exec_shell', 'exec_shell', 'delete_file'], 'deletes are still asked about');
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
