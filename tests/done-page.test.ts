// Before "done", ocode checks the work the way the person will see it: a web project's page opened at the address its
// dev server really listens on, a static site's changed .html files. Check durations outlive the session, and every
// process ocode started is stopped when it exits.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runTurn } from '../src/agent/turn/turn';
import { autoSteps } from '../src/agent/turn/check-plan';
import { checkCommands, runAfterEditCheck, runBeforeDoneCheck } from '../src/agent/turn/after-edit';
import { ContextStore } from '../src/context/store';
import { createWorkspaceState } from '../src/context/workspace-state';
import { loadMemory } from '../src/context/memory';
import { DEFAULTS } from '../src/core/config';
import { isGone, killTreeSync } from '../src/env/process/index';
import { listeningPorts } from '../src/tool/process/analysis/listening-ports';
import { ToolExecutor } from '../src/tool/core/tool-runtime';
import { ROLE } from '../src/protocol';

const never = () => undefined;
const react = { id: 'node', label: 'Node.js', frameworks: ['React'], dev: ['npm', 'run', 'dev'], root: '.' } as any;

describe('the page step', () => {
  it('comes last before done, for a web project with a dev script, and for changed .html files with no project', () => {
    assert.deepEqual(autoSteps('done', [react], ['src/App.jsx'], never), ['page']);
    assert.deepEqual(autoSteps('done', [], ['index.html', 'style.css'], never), ['page']);
    assert.deepEqual(autoSteps('done', [], ['style.css'], never), [], 'no page among the changes');
    assert.deepEqual(autoSteps('done', [react], ['README.md'], never), [], 'documentation only');
    assert.deepEqual(autoSteps('done', [{ ...react, dev: undefined }], ['src/App.jsx'], never), [], 'nothing serves it');
    assert.deepEqual(autoSteps('edit', [react], ['src/App.jsx'], never), [], 'not after every edit');
  });

  it('can be named in a setting, and "off" names nothing', () => {
    assert.deepEqual(checkCommands('build page'), ['build', 'page']);
    assert.deepEqual(checkCommands('off'), []);
    assert.equal(DEFAULTS.agent.beforeDone, 'auto');
  });
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: args } });
const BROKEN = { ok: true, kind: 'text', display: 'Uncaught script error: price is not defined', data: { findings: [{ check: 'scripts', severity: 'error', message: 'Uncaught script error' }] } };
const ADVICE = { ok: true, kind: 'text', display: 'Contrast could be higher', data: { findings: [{ check: 'accessibility', severity: 'warning', message: 'contrast' }] } };

/** A turn with the real tools, except check_page, which answers from `pages` and records what it was asked to open. */
async function turn(root: string, replies: any[], pages: any[]) {
  const state: any = Object.assign(createWorkspaceState(root), { autoFixAuthorized: true });
  const real = new ToolExecutor({ root, state });
  const ran: string[] = [];
  const opened: any[] = [];
  const requests: any[] = [];
  const notes: string[] = [];
  const history = new ContextStore({ messages: [{ role: ROLE.USER, content: 'make the shop page' }], budgetTokens: 8000 });
  const result: any = await runTurn({
    model: 'test', history, toolsEnabled: true, state,
    config: { maxIterations: 8, beforeDone: 'auto' },
    callbacks: { note: (text: string) => notes.push(text) },
    gateway: {
      model: 'test', provider: { id: 'test' },
      async stream(request: any) {
        requests.push(request);
        const next = replies[requests.length - 1] ?? { content: 'Done.' };
        return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
      },
    } as any,
    toolRunner: {
      async run(name: string, args: any, opts: any) {
        ran.push(name === 'exec_shell' ? `exec_shell ${args.command}${args.background ? ' (background)' : ''}` : name);
        if (name === 'check_page') {
          opened.push(args);
          return { result: pages.shift() ?? { ok: true, kind: 'text', display: 'No problems found', data: { findings: [] } }, durationMs: 1 };
        }
        return real.run(name, args, opts);
      },
    } as any,
  } as any);
  return { state, ran, opened, requests, notes, result };
}

describe('agent.beforeDone auto on a web project', () => {
  it('starts its dev server, opens the page where the system says it listens, and a broken page sends the model back', async (t) => {
    if ((await listeningPorts(process.pid)) === null) return t.skip('this system cannot list listeners');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-page-'));
    fs.mkdirSync(path.join(root, 'shop/src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shop/package.json'), JSON.stringify({ scripts: { dev: 'node server.js' }, dependencies: { react: '19' } }));
    // Listens on a port the system picks: the only way to know it is to ask the system.
    fs.writeFileSync(path.join(root, 'shop/server.js'), "require('http').createServer((q, s) => s.end('ok')).listen(0);\n");
    let t1: Awaited<ReturnType<typeof turn>> | undefined;
    try {
      t1 = await turn(root, [
        { toolCalls: [call('1', 'write_file', { path: 'shop/src/App.jsx', content: 'export default () => price' })] },
        { content: 'The shop page is ready.' },
        { toolCalls: [call('2', 'write_file', { path: 'shop/src/App.jsx', content: 'export default () => 3' })] },
        { content: 'Fixed the price; the page loads.' },
      ], [BROKEN]);
      assert.deepEqual(t1.ran, ['write_file', 'exec_shell npm run dev (background)', 'check_page', 'write_file', 'check_page'],
        'the server started once is reused for the second look');
      const job = [...t1.state.subprocesses.values()][0];
      const [port] = (await listeningPorts(job.pid))!;
      assert.deepEqual(t1.opened.map((a) => a.url), [`http://localhost:${port}/`, `http://localhost:${port}/`]);
      const seen = t1.requests[2].messages;
      const failure = seen.filter((m: any) => m.role === ROLE.TOOL).map((m: any) => String(m.content)).at(-1);
      assert.match(failure, /price is not defined/);
      assert.match(failure, /ocode ran this check \(agent\.beforeDone\)/);
      assert.equal(t1.result.answer, 'Fixed the price; the page loads.');
      assert.equal(t1.notes.at(-1), `Checked before finishing: \`check_page http://localhost:${port}/\` passed.`);
    } finally {
      t1?.state.reset();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  it('opens a static site\'s changed .html file, and advice alone does not hold the answer back', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-static-'));
    try {
      const t1 = await turn(root, [
        { toolCalls: [call('1', 'write_file', { path: 'index.html', content: '<h1>Shop</h1>' })] },
        { content: 'Done.' },
      ], [ADVICE]);
      assert.deepEqual(t1.opened, [{ path: 'index.html' }]);
      assert.equal(t1.requests.length, 2);
      assert.equal(t1.result.answer, 'Done.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('check durations', () => {
  it('outlive the session: a check known to be fast runs after the first edit of the next one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-times-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export {}');
    const ran: string[] = [];
    const toolRunner: any = {
      async run(_name: string, args: any) {
        ran.push(args.command);
        return { result: { ok: true, kind: 'command', display: 'ok', data: { execution: { exitCode: 0 } } }, durationMs: 2_000 };
      },
    };
    try {
      await runBeforeDoneCheck({ command: 'auto', memory: { root }, root, changed: ['a.ts'], toolRunner, callbacks: {} });
      assert.deepEqual(Object.values(loadMemory(root).agentState.checkMs ?? {}), [2_000]);
      ran.length = 0;
      // A new session: nothing measured in it yet.
      await runAfterEditCheck({ command: 'auto', memory: { root }, root, changed: ['a.ts'], history: { messages: [] }, toolRunner, callbacks: {} });
      assert.deepEqual(ran, ['npm run typecheck']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a check stopped with Ctrl+C', () => {
  it('is remembered as slow once it ran past fast, and not at all when stopped sooner', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-stopped-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }));
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(root, 'a.ts'), 'export {}');
    const stopAfter = (ms: number): any => {
      const controller = new AbortController();
      return {
        signal: controller.signal,
        toolRunner: {
          async run() {
            controller.abort();
            return { result: { ok: false, kind: 'command', code: 'ECANCELLED', error: 'cancelled' }, durationMs: ms };
          },
        },
      };
    };
    try {
      const soon = stopAfter(2_000);
      await runBeforeDoneCheck({ command: 'auto', memory: { root }, root, changed: ['a.ts'], toolRunner: soon.toolRunner, callbacks: {}, signal: soon.signal });
      assert.deepEqual(loadMemory(root).agentState.checkMs ?? {}, {}, 'two seconds says nothing about how long it takes');
      const late = stopAfter(40_000);
      await runBeforeDoneCheck({ command: 'auto', memory: { root }, root, changed: ['a.ts'], toolRunner: late.toolRunner, callbacks: {}, signal: late.signal });
      assert.deepEqual(Object.values(loadMemory(root).agentState.checkMs ?? {}), [40_000]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stopping what ocode started as it exits', () => {
  it('stops a process and what it started, with nothing left to wait for', async (t) => {
    if (process.platform !== 'linux') return t.skip('read from /proc; Windows goes through taskkill /T');
    const child = spawn('sh', ['-c', 'sleep 30 & echo $!; wait'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const grandchild = Number(await new Promise<string>((resolve) => child.stdout.once('data', (d) => resolve(String(d)))));
    killTreeSync(child.pid);
    await new Promise((resolve) => child.once('exit', resolve));
    // Killed, it is gone, or a zombie (Z) until something reaps it: a container's first process may never.
    const stopped = () => isGone(grandchild) || /^\d+ \(.*\) Z/.test(fs.readFileSync(`/proc/${grandchild}/stat`, 'utf8'));
    for (let i = 0; i < 50 && !stopped(); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(stopped(), true, 'the grandchild went with it');
  });
});
