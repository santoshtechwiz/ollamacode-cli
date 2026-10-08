import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { dangerousReason, shellConfirmReason, unbackupableDeleteReason } from '../src/tool/policy/mutation-policy';

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
