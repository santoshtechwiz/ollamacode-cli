import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { which, withExitCode } from '../src/tool/process/shell/runtime';

// Windows always has one; elsewhere the test runs when pwsh is installed and is skipped when it is not.
const powershell = which('pwsh') || which('powershell');

describe('a command run through PowerShell keeps its own exit code', { skip: !powershell && 'no PowerShell on this machine' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-pwsh-'));
  // A script file keeps the command free of quotes, which PowerShell mangles on the way to a program.
  fs.writeFileSync(path.join(dir, 'exit.js'), 'process.exit(Number(process.argv[2]));\n');
  const run = (command: string) =>
    spawnSync(powershell!, ['-NoProfile', '-NonInteractive', '-Command', withExitCode(command)], { cwd: dir, encoding: 'utf8' }).status;

  it('a program that fails reports its own code, not 1', () => assert.equal(run('node exit.js 3'), 3));
  it('the last command decides, as PowerShell decides it', () => {
    assert.equal(run('node exit.js 4; Get-Date'), 0);
    assert.equal(run('Get-Date; node exit.js 5'), 5);
  });
  it('a trailing comment cannot swallow the exit code', () => assert.equal(run('node exit.js 2 # note'), 2));
});
