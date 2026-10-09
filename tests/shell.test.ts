import assert from 'node:assert/strict';
import test, { describe, it } from 'node:test';
import { executeShell } from '../src/tool/process/execution/execute';
import { runsToEnd } from '../src/tool/process/analysis/runs-to-end';
import { dangerousReason, shellConfirmReason, unbackupableDeleteReason } from '../src/tool/policy/mutation-policy';
import os from 'node:os';
import { validateShellRequest } from '../src/tool/process/execution/request';
import fs from 'node:fs';
import path from 'node:path';
import execShell from '../src/tool/process/exec-shell.tool';
import { renderToolResult } from '../src/agent/router/render';

describe('exec-shell', () => {
  const command = `node -e "console.log('hello')"`;

  async function runCommand(cmd: string, options: { cwd?: string; timeoutMs?: number } = {}) {
    const result = await executeShell({
      command: cmd,
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? 120_000,
      signal: undefined,
      sandboxMode: undefined,
      env: undefined,
    });
    return result;
  }

  // Success
  test('executes a command successfully', async () => {
    const execution = await runCommand(command);
    
    assert.equal(execution.exitCode, 0);
    assert.match(execution.stdout, /hello/);
    assert.equal(execution.timedOut, false);
    assert.equal(execution.cancelled, false);
    assert.equal(execution.spawnError, null);
  });

  // Non-zero exit
  test('returns failure for a non-zero exit code', async () => {
    const execution = await runCommand(`node -e "console.error('boom'); process.exit(1)"`);
    
    assert.equal(execution.exitCode, 1);
    assert.match(execution.stderr, /boom/);
    assert.equal(execution.timedOut, false);
    assert.equal(execution.cancelled, false);
  });

  // Spawn/process error
  test('returns a structured result when the process cannot start', async () => {
    const execution = await runCommand('definitely-not-a-real-command-xyz');
    
    assert.notEqual(execution.exitCode, 0);
    assert.ok(execution.spawnError !== null || execution.exitCode !== 0);
  });

  // Timeout
  test('stops a command that exceeds the timeout', async () => {
    const execution = await runCommand(`node -e "setTimeout(() => {}, 10000)"`, { timeoutMs: 100 });
    
    assert.equal(execution.timedOut, true);
    // On timeout, the process is killed with SIGTERM (exit code 1) or similar
    assert.ok(execution.exitCode !== 0);
  });

  // Test, lint, build and type-check runs end on their own; a dev server does not
  test('tells a run that ends on its own from a server', () => {
    for (const c of ['npm test', 'npm run lint', 'dotnet build', 'tsc --noEmit', 'cargo check', 'pytest -q']) assert.equal(runsToEnd(c), true, c);
    for (const c of ['npm run dev', 'vite', 'dotnet run', 'python -m http.server']) assert.equal(runsToEnd(c), false, c);
  });
});

describe('shell-safety', () => {
  describe('shell safety reads every command in a chain', () => {
    it('a command in front of a delete or a force-push does not hide it', () => {
      assert.ok(dangerousReason('echo cleaning; rm -rf src', process.cwd()));
      assert.ok(dangerousReason('cd app && git push --force origin main', process.cwd()));
      assert.ok(dangerousReason('echo y | rm -rf src', process.cwd()));
      assert.ok(shellConfirmReason('echo x && git push origin main'));
      assert.ok(shellConfirmReason('echo cleaning; rm -rf src'));
    });

    it('text that is only printed is not a command', () => {
      assert.equal(dangerousReason('echo "rm -rf /"', process.cwd()), null);
      assert.equal(shellConfirmReason('echo "git push --force"'), null);
    });

    it('a loop or a dry run that deletes nothing is not refused', () => {
      assert.equal(unbackupableDeleteReason('for f in *.ts; do echo $f; done', process.cwd()), null);
      assert.equal(unbackupableDeleteReason('git clean -n', process.cwd()), null);
      assert.ok(unbackupableDeleteReason('git clean -fd', process.cwd()));
      assert.ok(unbackupableDeleteReason('for f in *; do rm $f; done', process.cwd()));
    });
  });

  describe('which shell commands run without asking, and which plan mode allows', () => {
    const root = process.cwd();
    const approval = async (command: string) => {
      await import('../src/tool/index');
      const { PermissionPolicy, createPermissions } = await import('../src/tool/policy/permission-policy');
      const { defaultRegistry } = await import('../src/tool/execution/registry');
      return new PermissionPolicy().decide({ toolName: 'exec_shell', args: { command }, toolDef: defaultRegistry.find('exec_shell'), cwd: root, root, permissions: createPermissions(), interactive: true } as any);
    };
    const planMode = async (command: string) => (await import('../src/tool/common/wired-policy')).classifyCall('exec_shell', { command }, { cwd: root, root });

    it('a command that only reads inside the workspace runs unasked', async () => {
      for (const c of ['ls', 'git status', 'git diff', 'cat package.json', 'node -v']) assert.equal(await approval(c), 'allow', c);
    });

    it('reading outside the workspace, running code, installing or deleting is asked about', async () => {
      for (const c of ['cat /etc/passwd', 'ls ..', 'npm test', 'pytest', 'npm install', 'rm a.txt', 'git status && rm -rf x']) assert.equal(await approval(c), 'ask', c);
    });

    it('plan mode may run tests, but not builds or installs', async () => {
      for (const c of ['npm test', 'npm run test', 'pytest', 'git status']) assert.equal(await planMode(c), 'read-only', c);
      for (const c of ['npm run build', 'npm install', 'rm a.txt']) assert.equal(await planMode(c), 'mutating', c);
    });
  });
});

describe('shell-timeout', () => {
  const timeoutOf = async (args: Record<string, unknown>, canAsk: boolean) => {
    const v: any = await validateShellRequest({ command: 'npm install', ...args }, { cwd: os.tmpdir(), root: os.tmpdir(), canAsk });
    return v.request.timeoutMs;
  };

  describe('how long a shell command may run', () => {
    it('in a chat, with no limit given, the person decides at the two-minute check-in', async () => {
      assert.equal(await timeoutOf({}, true), 0);
    });
    it('with nobody to ask, it keeps the two-minute default', async () => {
      assert.equal(await timeoutOf({}, false), 120_000);
    });
  });
});

describe('stopped-output', () => {
  describe('a command stopped before it exited', () => {
    it('still gives the model what it printed: a test run that failed and then never exited', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-stopped-'));
      // Prints its failures, then keeps an open handle, as a Jest run with an unclosed server or database does.
      fs.writeFileSync(path.join(dir, 'hang.js'), "console.log('Tests:       3 failed, 3 total');\nconsole.log('Jest did not exit one second after the test run has completed.');\nsetInterval(() => {}, 1000);\n");
      const stop = new AbortController();
      try {
        setTimeout(() => stop.abort(), 1500);
        const result: any = await execShell.execute({ command: 'node hang.js' }, { cwd: dir, root: dir, signal: stop.signal } as any);
        assert.equal(result.ok, false);
        const seen = renderToolResult(result, 'exec_shell');
        assert.match(seen, /stopped before it exited/);
        assert.match(seen, /Tests: +3 failed, 3 total/);
        assert.match(seen, /Jest did not exit/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
