import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BackgroundInbox, describeExitsForModel, describeExitForPerson, type BackgroundExit } from '../src/tool/process/background-inbox';
import startSubprocess from '../src/tool/process/start-subprocess.tool';
import stopSubprocess from '../src/tool/process/stop-subprocess.tool';
import { createWorkspaceState, describeSession } from '../src/context/workspace-state';
import { runTurn } from '../src/agent/turn/turn';
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
  it('keeps an exit for the model and tells every listener once', () => {
    const inbox = new BackgroundInbox();
    const heard: string[] = [];
    inbox.subscribe((e) => heard.push(e.id));
    inbox.record(exit('a', 1));
    assert.deepEqual(heard, ['a']);
    assert.deepEqual(inbox.pending().map((e) => e.id), ['a']);
  });

  it('drops what a turn showed the model, and keeps what ended after its last request', () => {
    const inbox = new BackgroundInbox();
    inbox.record(exit('shown', 100));
    inbox.markShown(150);
    inbox.record(exit('later', 200));
    inbox.settle();
    assert.deepEqual(inbox.pending().map((e) => e.id), ['later']);
  });

  it('a listener that fails never loses the exit for the model', () => {
    const inbox = new BackgroundInbox();
    inbox.subscribe(() => { throw new Error('terminal closed'); });
    inbox.record(exit('a', 1));
    assert.equal(inbox.pending().length, 1);
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

  it('says how it ended, plainly, to the model and to the person', () => {
    const failed = exit('docker-build', 1, { outcome: 'failed', exitCode: 1, tail: 'error during connect' });
    const lines = describeExitsForModel([failed]);
    assert.match(lines[0], /do not poll/);
    assert.equal(lines[1], '- docker-build: `build docker-build` failed (exit 1) after 2m 14s');
    assert.equal(lines[2], '    error during connect');
  });

  it('shows the person what the job printed, under one line saying how it ended', () => {
    // The note's own icon says how it went; the text carries no second mark.
    assert.equal(
      describeExitForPerson(exit('tests', 1)),
      'background "tests" finished (exit 0) after 2m 14s — the agent will see it with your next message\nBuild succeeded.',
    );
    const long = Array.from({ length: 9 }, (_, i) => `line ${i + 1}`).join('\n');
    assert.deepEqual(describeExitForPerson(exit('fetch', 1, { tail: `${long}\n` })).split('\n').slice(1), ['line 5', 'line 6', 'line 7', 'line 8', 'line 9']);
    assert.match(describeExitForPerson(exit('quiet', 1, { tail: '' })), /^background "quiet" finished \(exit 0\) after 2m 14s, printing nothing — /);
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
      const started = await startSubprocess.execute({ command: job(3), id: 'slow-build' }, t.ctx);
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
      const started = await startSubprocess.execute({ command: 'node fetch.js', id: 'price' }, t.ctx);
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

  it('a process the agent stopped itself is not reported', async () => {
    const t = session();
    try {
      await startSubprocess.execute({ command: job(0), id: 'server' }, t.ctx);
      await stopSubprocess.execute({ id: 'server' }, t.ctx);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(t.state.background.pending().length, 0);
    } finally {
      await t.cleanup();
    }
  });
});

describe('a job that finishes before it reaches the background', () => {
  it('says it is done when the job finished while starting', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-bg-'));
    fs.writeFileSync(path.join(cwd, 'build.js'), "console.log('Build succeeded.');\n");
    const state: any = createWorkspaceState(cwd);
    const history = new ContextStore({ messages: [{ role: ROLE.USER, content: 'run the full build in the background' }], budgetTokens: 8000 });
    const start = (id: string, n: string) => ({ id: n, type: 'function', function: { name: 'start_subprocess', arguments: { command: 'node build.js', id } } });
    const replies = [
      { toolCalls: [start('full-build-background', 'c1')] },
      { toolCalls: [start('full-build-bg', 'c2')] },
      { content: 'The build succeeded.' },
    ];
    let asked = 0;
    try {
      await runTurn({
        model: 'test',
        history,
        config: { maxIterations: 6 },
        state,
        toolProfile: { always: ['start_subprocess'] },
        gateway: {
          model: 'test',
          provider: { id: 'test' },
          async stream() {
            const r = replies[asked++] ?? { content: 'done' };
            return { result: { content: r.content ?? '', toolCalls: r.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
          },
        } as any,
        toolRunner: { async run(_name: string, args: any) { return { result: await startSubprocess.execute(args, { cwd, root: cwd, state } as any) }; } } as any,
      } as any);
      const results = history.messages.filter((m) => m.role === ROLE.TOOL).map((m) => String(m.content));
      assert.match(results[0], /finished \(exit 0\) while starting/);
      assert.match(results[0], /That job is complete/);
    } finally {
      await removeWorkspace(cwd, state);
    }
  });
});

describe('a reworded restart that keeps finding nothing new', () => {
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
