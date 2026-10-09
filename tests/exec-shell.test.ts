import assert from 'node:assert/strict';
import test from 'node:test';
import { executeShell } from '../src/tool/process/execution/execute';
import { runsToEnd } from '../src/tool/process/analysis/runs-to-end';

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