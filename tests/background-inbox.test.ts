import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BackgroundInbox, type BackgroundExit } from '../src/tool/process/background-inbox';
import { runInBackground } from '../src/tool/process/background';
import stopSubprocess from '../src/tool/process/stop-subprocess.tool';
import { createWorkspaceState, describeSession } from '../src/context/workspace-state';
import { ContextStore } from '../src/context/store';
import { ROLE, STOP_REASONS } from '../src/protocol';
import { killProcessTreeAndWait } from '../src/env/process/kill';

const exit = (id: string, endedAt: number, over: Partial<BackgroundExit> = {}): BackgroundExit => ({
  id, command: `build ${id}`, outcome: 'finished', exitCode: 0, signal: null, durationMs: 134_000, tail: 'Build succeeded.', endedAt, ...over,
});

/**
 * Remove a job's folder. Anything still running is stopped first, so a failed assertion reports itself rather than
 * a locked folder; Windows also holds a just-ended process's working folder for a moment, which the retries wait out.
 */
async function removeWorkspace(cwd: string, state: any): Promise<void> {
  for (const sub of state?.subprocesses?.values() ?? []) {
    sub.stopRequested = true;
    await killProcessTreeAndWait(sub.process);
  }
  fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

describe('the background inbox', () => {

  it('drops what a turn showed the model, and keeps what ended after its last request', () => {
    const inbox = new BackgroundInbox();
    inbox.record(exit('shown', 100));
    inbox.markShown(150);
    inbox.record(exit('later', 200));
    inbox.settle();
    assert.deepEqual(inbox.pending().map((e) => e.id), ['later']);
  });

  it('a new conversation starts empty, and listeners keep listening', () => {
    const inbox = new BackgroundInbox();
    const heard: string[] = [];
    inbox.subscribe((e) => heard.push(e.id));
    inbox.record(exit('old', 1));
    inbox.clear();
    inbox.record(exit('new', 2));
    assert.deepEqual(inbox.pending().map((e) => e.id), ['new']);
    assert.deepEqual(heard, ['old', 'new']);
  });
});

// Each test has its own folder and state, so they wait on their jobs side by side.
describe('a background process that ends tells the session', { concurrency: true }, () => {
  const session = () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-bg-'));
    // Prints, goes quiet (so the start tool hands it to the background), then ends on its own with the code it is given.
    // A script file, not `node -e "…"`: the command then has no quotes, and reads the same in PowerShell, cmd and bash.
    fs.writeFileSync(path.join(cwd, 'job.js'), "console.log('working');\nsetTimeout(() => process.exit(Number(process.argv[2])), 3500);\n");
    const state = createWorkspaceState(cwd);
    return { cwd, state, ctx: { cwd, root: cwd, state } as any, cleanup: () => removeWorkspace(cwd, state) };
  };
  const job = (code: number) => `node job.js ${code}`;
  // An exit recorded before the wait began counts, and one that never comes fails the test rather than hanging the run.
  const ended = (state: any, withinMs = 30_000) => {
    const already = state.background.pending()[0];
    if (already) return Promise.resolve<BackgroundExit>(already);
    return new Promise<BackgroundExit>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no background exit was recorded within ${withinMs}ms`)), withinMs);
      state.background.subscribe((exit: BackgroundExit) => {
        clearTimeout(timer);
        resolve(exit);
      });
    });
  };

  it('records the end of a job it was not watching, and the model sees it in the session record', async () => {
    const t = session();
    try {
      const started = await runInBackground({ command: job(3), id: 'slow-build' }, t.ctx);
      assert.equal(started.ok, true, String(started.error));
      assert.match(String(started.display), /do not poll/);
      const done = await ended(t.state);
      assert.equal(done.id, 'slow-build');
      assert.equal(done.outcome, 'failed');
      assert.equal(done.exitCode, 3, `the job printed:\n${done.tail}`);
      assert.match(done.tail, /working/);
      assert.match(describeSession(t.state), /slow-build: `.*` failed \(exit 3\)/);
    } finally {
      await t.cleanup();
    }
  });

  it('hands a job that prints nothing until it ends to the background, instead of waiting for it', async () => {
    const t = session();
    // A fetch: silent while it works, prints its result as it ends — after the 5s silent-start window has handed it over.
    fs.writeFileSync(path.join(t.cwd, 'fetch.js'), "setTimeout(() => console.log('GOOGL 338.24'), 6500);\n");
    try {
      const started = await runInBackground({ command: 'node fetch.js', id: 'price' }, t.ctx);
      assert.equal(started.ok, true, String(started.error));
      // Not "finished … while starting": the start came back while the job was still running.
      assert.match(String(started.display), /^Running in the background as "price"/);
      const done = await ended(t.state);
      assert.equal(done.outcome, 'finished');
      assert.match(done.tail, /GOOGL 338\.24/);
    } finally {
      await t.cleanup();
    }
  });

  it('starting the same command again starts a second job beside the first, never in its place', async () => {
    const t = session();
    try {
      fs.writeFileSync(path.join(t.cwd, 'serve.js'), "console.log('up');\nsetInterval(() => {}, 1000);\n");
      const first = await runInBackground({ command: 'node serve.js' }, t.ctx);
      const second = await runInBackground({ command: 'node serve.js' }, t.ctx);
      assert.match(String(first.display), /^Running in the background as "node-serve-js"/);
      assert.match(String(second.display), /^Running in the background as "node-serve-js-2"/);
      const held = [...t.state.subprocesses.values()] as any[];
      assert.equal(held.length, 2);
      assert.ok(held.every((sub) => !sub.stopRequested && !sub.exited), 'the first job is still running');
    } finally {
      await t.cleanup();
    }
  });

  it('a process the agent stopped itself is not reported', async () => {
    const t = session();
    try {
      await runInBackground({ command: job(0), id: 'server' }, t.ctx);
      await stopSubprocess.execute({ id: 'server' }, t.ctx);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(t.state.background.pending().length, 0);
    } finally {
      await t.cleanup();
    }
  });
});

describe('a background process that ended reaches the model as news', () => {
  it('sits after the "for reference only" block, right before the person\'s words', async () => {
    const { buildModelRequest } = await import('../src/context/builder');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-news-'));
    try {
      const state = createWorkspaceState(root);
      state.background.record(exit('fizzbuzz', 1, { tail: 'FizzBuzz' }));
      const store = new ContextStore();
      store.addUser('run the fizz app', { pinned: true });

      const { messages } = await buildModelRequest({ store, state });
      const request = String(messages.at(-1)?.content);
      const reference = request.slice(0, request.indexOf('[End of workspace context]'));
      const after = request.slice(request.indexOf('[End of workspace context]'));

      assert.doesNotMatch(reference, /fizzbuzz/, 'not filed under reference material');
      assert.match(after, /Background processes that ended[\s\S]*fizzbuzz[\s\S]*FizzBuzz[\s\S]*run the fizz app$/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
