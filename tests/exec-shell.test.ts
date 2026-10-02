import assert from 'node:assert/strict';
import test from 'node:test';
import { executeShell } from '../src/tool/process/execution/execute';
import { classifyCommand } from '../src/tool/process/analysis/classify-command';
import { parseShellDiagnostics } from '../src/tool/process/analysis/diagnostics';
import { createVerificationMetadata } from '../src/tool/process/analysis/verification';
import { generateHints } from '../src/tool/process/hints/command-hints';
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

// Structured classification exists
test('returns command classification', async () => {
  const execution = await runCommand('npm test');
  const classification = classifyCommand('npm test');
  
  assert.ok(classification);
  assert.equal(typeof classification.category, 'string');
  assert.equal(classification.category, 'test');
});

// Verification classification is structured
test('classifies verification commands with structured metadata', async () => {
  const execution = await runCommand('npm test');
  const classification = classifyCommand('npm test');
  const diagnostics = await parseShellDiagnostics(execution.stdout, execution.stderr, { command: 'npm test', cwd: process.cwd() });
  const verification = createVerificationMetadata({ execution, classification, diagnostics });
  
  assert.ok(verification);
  assert.equal(typeof verification.intent, 'string');
  assert.equal(verification.intent, 'test');
});

// Hints are data, not control flow
test('returns command hints as structured data', async () => {
  const execution = await runCommand(`node -e "process.exit(1)"`);
  const classification = classifyCommand(`node -e "process.exit(1)"`);
  const diagnostics = await parseShellDiagnostics(execution.stdout, execution.stderr, { command: `node -e "process.exit(1)"`, cwd: process.cwd() });
  const verification = createVerificationMetadata({ execution, classification, diagnostics });
  const recovery = { kind: 'none' as const, attempted: false, succeeded: null, detail: '', killedPids: [], requiresApproval: false };
  const request = { command: `node -e "process.exit(1)"`, cwd: process.cwd(), timeoutMs: 120_000 };
  
  const hints = generateHints({ execution, classification, verification, recovery, request });
  
  assert.equal(execution.exitCode, 1);
  assert.ok(Array.isArray(hints));
});

// Result has stable process contract
test('returns the complete process result contract', async () => {
  const execution = await runCommand(command);
  const classification = classifyCommand(command);
  const diagnostics = await parseShellDiagnostics(execution.stdout, execution.stderr, { command, cwd: process.cwd() });
  const verification = createVerificationMetadata({ execution, classification, diagnostics });
  const recovery = { kind: 'none' as const, attempted: false, succeeded: null, detail: '', killedPids: [], requiresApproval: false };
  const request = { command, cwd: process.cwd(), timeoutMs: 120_000 };
  const hints = generateHints({ execution, classification, verification, recovery, request });
  const formatted = formatOutput({ execution, hints, command, diagnostics });
  
  assert.equal(typeof execution.exitCode, 'number');
  assert.equal(typeof execution.stdout, 'string');
  assert.equal(typeof execution.stderr, 'string');
  assert.ok(Array.isArray(hints));
  assert.ok(Array.isArray(diagnostics));
  assert.equal(typeof execution.timedOut, 'boolean');
  assert.equal(typeof execution.cancelled, 'boolean');
  assert.equal(typeof formatted.presentation, 'string');
  assert.equal(typeof formatted.truncated, 'boolean');
});