import assert from 'node:assert/strict';
import test from 'node:test';
import { executeShell } from '../src/tool/process/execution/execute';
import { runsToEnd } from '../src/tool/process/analysis/runs-to-end';
import { parseShellDiagnostics } from '../src/tool/process/analysis/diagnostics';
import { formatOutput } from '../src/tool/process/output/presentation';

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

// stdout and stderr are preserved
test('preserves stdout and stderr separately', async () => {
  const execution = await runCommand(`node -e "console.log('out'); console.error('err')"`);
  
  assert.equal(execution.exitCode, 0);
  assert.match(execution.stdout, /out/);
  assert.match(execution.stderr, /err/);
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

// Successful command containing "failed" must remain successful
test('does not treat failure-like output as command failure', async () => {
  const execution = await runCommand(`node -e "console.log('previous test failed but this command succeeded')"`);
  
  assert.equal(execution.exitCode, 0);
  assert.match(execution.stdout, /failed/);
});

// Test, lint, build and type-check runs end on their own; a dev server does not
test('tells a run that ends on its own from a server', () => {
  for (const c of ['npm test', 'npm run lint', 'dotnet build', 'tsc --noEmit', 'cargo check', 'pytest -q']) assert.equal(runsToEnd(c), true, c);
  for (const c of ['npm run dev', 'vite', 'dotnet run', 'python -m http.server']) assert.equal(runsToEnd(c), false, c);
});

// Result has stable process contract
test('returns the complete process result contract', async () => {
  const execution = await runCommand(command);
  const diagnostics = await parseShellDiagnostics(execution.stdout, execution.stderr, { command, cwd: process.cwd() });
  const formatted = formatOutput({ execution, command, diagnostics });
  
  assert.equal(typeof execution.exitCode, 'number');
  assert.equal(typeof execution.stdout, 'string');
  assert.equal(typeof execution.stderr, 'string');
  assert.ok(Array.isArray(diagnostics));
  assert.equal(typeof execution.timedOut, 'boolean');
  assert.equal(typeof execution.cancelled, 'boolean');
  assert.equal(typeof formatted.presentation, 'string');
  assert.equal(typeof formatted.truncated, 'boolean');
});