import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { saveSession, lastSession, newSessionId, listSessions, MAX_SESSIONS, sessionTitle } from '../src/core/sessions';
import { runSessions } from '../src/cli/commands/cmds/sessions';
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

const tick = () => new Promise((r) => setTimeout(r, 3));

/** Saves n conversations a few ms apart, so their order is their age; returns their ids, oldest first. */
async function saveMany(root: string, n: number, label = 'task'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = newSessionId();
    saveSession(record(id, `${label} ${i}`), root);
    ids.push(id);
    await tick();
  }
  return ids;
}

test(`the newest ${MAX_SESSIONS} sessions are kept, the oldest go first`, async () => {
  const root = workspace();
  const ids = await saveMany(root, MAX_SESSIONS + 2);
  assert.equal(sessionFiles(root).length, MAX_SESSIONS);
  assert.deepEqual(listSessions(root).map((r) => r.id), ids.slice(2).reverse(), 'newest first, the two oldest gone');
  assert.equal(lastSession(root)?.id, ids.at(-1));
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

test('a session that falls off the list takes its undo snapshots and checkpoint with it', async () => {
  const root = workspace();
  const old = newSessionId();
  saveSession(record(old, 'old task'), root);
  const recovery = path.join(root, '.ollamacode', 'recovery', old);
  const checkpoint = path.join(root, '.ollamacode', 'checkpoints', `${old}.json`);
  fs.mkdirSync(recovery, { recursive: true });
  fs.writeFileSync(path.join(recovery, 'ledger.json'), '{}');
  fs.mkdirSync(path.dirname(checkpoint), { recursive: true });
  fs.writeFileSync(checkpoint, '{}');

  await tick();
  await saveMany(root, MAX_SESSIONS - 1, 'newer task');
  assert.equal(fs.existsSync(recovery), true, 'still among the newest: kept whole');
  await saveMany(root, 1, 'one more');
  assert.equal(fs.existsSync(recovery), false);
  assert.equal(fs.existsSync(checkpoint), false);
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
    await tick();
    await saveMany(root, MAX_SESSIONS, 'my task');
    assert.ok(sessionFiles(root).includes(`${theirs}.json`), 'past the limit, but another window holds it');
  } finally {
    other.kill();
  }
  // Once that window is gone, the next save cleans its record up.
  // One that already exited sends no second 'exit': waiting for it would never end.
  if (other.exitCode === null && other.signalCode === null) await new Promise((r) => other.once('exit', r));
  saveSession(record(newSessionId(), 'later task'), root);
  assert.equal(sessionFiles(root).includes(`${theirs}.json`), false);
  assert.equal(sessionFiles(root).length, MAX_SESSIONS);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the saved summary counts every message trimmed so far, not just the latest save', () => {
  const root = workspace();
  const id = newSessionId();
  const big = (n: number) => ({ id: `m${n}`, role: n % 2 ? 'assistant' : 'user', content: `turn ${n} `.padEnd(40_000, 'x') });
  const batch = (from: number) => Array.from({ length: 8 }, (_, k) => big(from + k));

  saveSession({ ...record(id, 'first'), messages: batch(0) }, root);
  const saved = saveSession({ ...record(id, 'second'), messages: batch(8) }, root);

  const omitted = Number(/trimmed: (\d+) message/.exec(String(saved.summary))?.[1]);
  assert.ok(omitted > 0, 'the record was over budget, so something was trimmed');
  assert.equal(omitted + saved.messages.length, 16, 'every message saved is either kept or counted as trimmed');
});

test('/sessions lists conversations by their first question, and /sessions <n> switches to that one', async () => {
  const root = workspace();
  const ids = await saveMany(root, 3, 'question');
  const out: string[] = [];
  const switched: string[] = [];
  const ctx = { sessionsRoot: root, currentSessionId: () => ids[2], write: (t: string) => out.push(t), switchSession: (rec: any) => { switched.push(rec.id); return null; } };
  await runSessions(ctx, '');
  const listing = out.join('');
  assert.ok(listing.indexOf('question 2') < listing.indexOf('question 0'), 'newest first');
  assert.equal(sessionTitle(listSessions(root)[0]), 'question 2');
  await runSessions(ctx, '3');
  assert.deepEqual(switched, [ids[0]], 'the third listed is the oldest');
  out.length = 0;
  await runSessions(ctx, '9');
  assert.match(out.join(''), /no session 9/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('agent settings written at the top level of config.json are read as if under "agent"', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-cfg-'));
  const before = process.env.OLLAMACODE_HOME;
  process.env.OLLAMACODE_HOME = home;
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
      subagentRoles: { security: { instruction: 'check it', also: ['exec_shell'] } },
      afterEdit: 'npm test',
      agent: { afterEdit: 'npm run lint' },
    }));
    const { agentConfig } = await import('../src/core/config');
    const { allRoles } = await import('../src/agent/subagent/roles');
    assert.deepEqual(allRoles().security?.also, ['exec_shell'], 'a role pasted without its "agent" wrapper still loads');
    assert.equal(agentConfig().afterEdit, 'npm run lint', 'one set inside "agent" wins');
  } finally {
    if (before === undefined) delete process.env.OLLAMACODE_HOME; else process.env.OLLAMACODE_HOME = before;
  }
});
