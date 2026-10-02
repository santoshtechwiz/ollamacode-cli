import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { saveSession, lastSession, claimSession, releaseSessionClaim, newSessionId } from '../src/core/sessions';
import { SESSION_RECORD_VERSION, EPHEMERAL_SESSION } from '../src/protocol';

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-sessions-'));
}

function record(id: string, text: string) {
  return {
    version: SESSION_RECORD_VERSION,
    id,
    providerId: 'test',
    model: 'test',
    toolsEnabled: true,
    messages: [{ role: 'user', content: text }] as any[],
  };
}

const sessionFiles = (root: string) => fs.readdirSync(path.join(root, '.ollamacode', 'sessions')).filter((f) => f.endsWith('.json'));

test('only the last session is kept', () => {
  const root = workspace();
  const first = newSessionId();
  const second = newSessionId();
  saveSession(record(first, 'first task'), root);
  saveSession(record(second, 'second task'), root);
  assert.deepEqual(sessionFiles(root), [`${second}.json`]);
  assert.equal(lastSession(root)?.id, second);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an ephemeral session (ocode init writing its doc) never replaces the last conversation', () => {
  const root = workspace();
  const mine = newSessionId();
  saveSession(record(mine, 'my real conversation'), root);
  saveSession(record(EPHEMERAL_SESSION, 'write OLLAMACODE.md documenting this project'), root);
  assert.deepEqual(sessionFiles(root), [`${mine}.json`], 'nothing written for the ephemeral run, nothing deleted');
  assert.equal(lastSession(root)?.messages[0]?.content, 'my real conversation');
  fs.rmSync(root, { recursive: true, force: true });
});

test('a new session takes the old one with it: undo snapshots and checkpoint too', () => {
  const root = workspace();
  const old = newSessionId();
  saveSession(record(old, 'old task'), root);
  const recovery = path.join(root, '.ollamacode', 'recovery', old);
  const checkpoint = path.join(root, '.ollamacode', 'checkpoints', `${old}.json`);
  fs.mkdirSync(recovery, { recursive: true });
  fs.writeFileSync(path.join(recovery, 'ledger.json'), '{}');
  fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
  fs.writeFileSync(checkpoint, '{}');

  saveSession(record(newSessionId(), 'new task'), root);
  assert.equal(fs.existsSync(recovery), false);
  assert.equal(fs.existsSync(checkpoint), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test('no saved session means nothing to continue', () => {
  const root = workspace();
  assert.equal(lastSession(root), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a session another live window holds is not deleted', async () => {
  const root = workspace();
  const theirs = newSessionId();
  saveSession(record(theirs, 'their task'), root);
  // A lock owned by a live process other than this one, as a second ocode window leaves it.
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(path.join(root, '.ollamacode', 'sessions', `${theirs}.json.lock`), JSON.stringify({ pid: other.pid, startedAt: Date.now() }));
    const mine = newSessionId();
    assert.equal(claimSession(root, mine).ok, true);
    saveSession(record(mine, 'my task'), root);
    assert.deepEqual(sessionFiles(root).sort(), [`${mine}.json`, `${theirs}.json`].sort());
    releaseSessionClaim(root, mine);
  } finally {
    other.kill();
  }
  // Once that window is gone, the next save cleans its record up.
  await new Promise((r) => other.once('exit', r));
  saveSession(record(newSessionId(), 'later task'), root);
  assert.equal(sessionFiles(root).length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});
