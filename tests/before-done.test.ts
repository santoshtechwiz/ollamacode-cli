// agent.beforeDone checks "done" the way the person asked (a build that prerenders pages), and agent.afterEdit can name
// several checks, with lint run only on the files that changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { ROLE } from '../src/protocol';
import { checkCommands } from '../src/agent/turn/after-edit';

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, type: 'function', function: { name, arguments: args } });

/** A Next.js-like project: ESLint with the Vue plugin, a build script. */
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-done-'));
  fs.mkdirSync(path.join(root, 'site/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site/package.json'), JSON.stringify({
    scripts: { build: 'next build', lint: 'eslint' },
    devDependencies: { eslint: '9', 'eslint-plugin-vue': '9', typescript: '5' },
  }));
  fs.writeFileSync(path.join(root, 'site/tsconfig.json'), '{}');
  return root;
}

async function turn(root: string, replies: any[], config: Record<string, unknown>, buildResults: Array<boolean | 'timeout'>) {
  const requests: any[] = [];
  const ran: string[] = [];
  const limits: number[] = [];
  const notes: string[] = [];
  const state: any = { mutationCount: 0, changes: [], root };
  const history = new ContextStore({ messages: [{ role: ROLE.USER, content: 'build the page' }], budgetTokens: 8000 });
  const result: any = await runTurn({
    model: 'test', history, toolsEnabled: true, state,
    config: { maxIterations: 8, ...config },
    callbacks: { note: (text: string, tone: string) => notes.push(`${tone}: ${text}`) },
    gateway: {
      model: 'test', provider: { id: 'test' },
      async stream(request: any) {
        requests.push(request);
        const next = replies[requests.length - 1] ?? { content: 'Done.' };
        return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
      },
    } as any,
    toolRunner: {
      async run(name: string, args: any) {
        ran.push(name === 'exec_shell' ? `${args.command}${args.cwd ? ` in ${args.cwd}` : ''}` : name);
        if (name === 'write_file') {
          fs.mkdirSync(path.dirname(path.join(root, args.path)), { recursive: true });
          fs.writeFileSync(path.join(root, args.path), String(args.content));
          state.mutationCount += 1;
          state.changes = [...state.changes.filter((c: any) => c.path !== args.path), { path: args.path }];
        }
        if (name === 'exec_shell') limits.push(args.timeout_ms);
        if (name === 'exec_shell' && /build/.test(args.command)) {
          const passes = buildResults.shift() ?? true;
          if (passes === 'timeout') {
            return { result: { ok: false, kind: 'none', code: 'ETIMEDOUT', error: `Command timed out after ${args.timeout_ms}ms`, data: {} } };
          }
          return { result: passes
            ? { ok: true, kind: 'command', display: 'Compiled successfully', data: { execution: { exitCode: 0 } } }
            : { ok: false, kind: 'command', error: 'Command exited with code 1', display: 'Error: Route "/" used `new Date()` while prerendering', data: { execution: { exitCode: 1 } } } };
        }
        return { result: { ok: true, kind: 'command', display: 'ok', data: { execution: { exitCode: 0 } } } };
      },
    } as any,
  } as any);
  return { requests, ran, result, history, limits, notes };
}

describe('checkCommands', () => {
  it('reads words that are all checks as several, anything else as one command', () => {
    assert.deepEqual(checkCommands('check lint'), ['check', 'lint']);
    assert.deepEqual(checkCommands('npm test'), ['npm test']);
    assert.deepEqual(checkCommands('lint npm'), ['lint npm']);
    assert.deepEqual(checkCommands('  '), []);
  });
});

describe('agent.afterEdit with several checks', () => {
  it('runs each, and lints only the changed files the linter reads', async () => {
    const root = project();
    try {
      const t = await turn(root, [
        { toolCalls: [call('1', 'write_file', { path: 'site/src/Footer.tsx', content: 'x' }), call('2', 'write_file', { path: 'site/src/App.vue', content: 'y' }), call('3', 'write_file', { path: 'site/src/site.css', content: 'z' })] },
        { content: 'Done.' },
      ], { afterEdit: 'check lint' }, []);
      assert.deepEqual(t.ran.slice(3), ['npx tsc --noEmit in site', 'npx eslint src/Footer.tsx src/App.vue in site']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs a command two words name only once (Go\'s check and lint are both go vet)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-go-'));
    try {
      fs.mkdirSync(path.join(root, 'svc'));
      fs.writeFileSync(path.join(root, 'svc/go.mod'), 'module svc\n\ngo 1.22\n');
      const t = await turn(root, [{ toolCalls: [call('1', 'write_file', { path: 'svc/main.go', content: 'package main' })] }, { content: 'Done.' }], { afterEdit: 'check lint' }, []);
      assert.deepEqual(t.ran.filter((r) => r !== 'write_file').map((r) => r.replace(/^\S*go(?:\.exe)? /, 'go ')), ['go vet ./... in svc']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives Python\'s ruff only the changed .py files', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-py-'));
    try {
      fs.mkdirSync(path.join(root, 'api'));
      fs.writeFileSync(path.join(root, 'api/pyproject.toml'), '[project]\nname = "api"\n');
      const t = await turn(root, [{ toolCalls: [call('1', 'write_file', { path: 'api/app.py', content: 'x = 1' }), call('2', 'write_file', { path: 'api/README.md', content: '# api' })] }, { content: 'Done.' }], { afterEdit: 'lint' }, []);
      assert.deepEqual(t.ran.filter((r) => r !== 'write_file').map((r) => r.replace(/^\S+ -m ruff/, 'python -m ruff')), ['python -m ruff check app.py in api']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips lint when no changed file is one the linter reads', async () => {
    const root = project();
    try {
      const t = await turn(root, [{ toolCalls: [call('1', 'write_file', { path: 'site/src/site.css', content: 'z' })] }, { content: 'Done.' }], { afterEdit: 'lint' }, []);
      assert.deepEqual(t.ran, ['write_file']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('agent.beforeDone', () => {
  it('runs the build when the model answers; a failure goes back to it and the turn goes on until it passes', async () => {
    const root = project();
    try {
      const t = await turn(root, [
        { toolCalls: [call('1', 'write_file', { path: 'site/src/Footer.tsx', content: 'new Date()' })] },
        { content: 'Done: the site is ready.' },
        { toolCalls: [call('2', 'write_file', { path: 'site/src/Footer.tsx', content: '2026' })] },
        { content: 'Fixed the footer; the build passes.' },
      ], { beforeDone: 'build' }, [false, true]);
      assert.deepEqual(t.ran, ['write_file', 'npm run build in site', 'write_file', 'npm run build in site']);
      const seen = t.requests[2].messages;
      const failure = seen.filter((m: any) => m.role === ROLE.TOOL).map((m: any) => String(m.content)).at(-1);
      assert.match(failure, /new Date\(\)` while prerendering/);
      assert.match(failure, /ocode ran this check \(agent\.beforeDone\) when you answered, and it failed: the work is not done/);
      const said = seen.filter((m: any) => m.role === ROLE.ASSISTANT).at(-1);
      assert.equal(said.content, 'Done: the site is ready.', 'the answer stays, as what the model said before the check');
      assert.equal(t.result.answer, 'Fixed the footer; the build passes.');
      assert.deepEqual(t.notes, [
        'warn: Not done yet: `npm run build` failed after that answer, so the agent keeps working on what it reports.',
        'success: Checked before finishing: `npm run build` passed.',
      ], 'the screen says the first answer was not final, and that the last one was checked');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('gives every check a time limit, and a check that runs out of time is unfinished, not a failure to fix', async () => {
    const root = project();
    try {
      const t = await turn(root, [
        { toolCalls: [call('1', 'write_file', { path: 'site/src/Footer.tsx', content: 'x' })] },
        { content: 'Done.' },
      ], { afterEdit: 'check', beforeDone: 'build', checkTimeoutMs: 45_000 }, ['timeout']);
      assert.deepEqual(t.limits, [45_000, 45_000], 'agent.checkTimeoutMs reaches both checks');
      assert.equal(t.result.answer, 'Done.', 'a build that ran out of time does not send the model back');
      assert.equal(t.requests.length, 2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('without agent.checkTimeoutMs, a check after an edit gets 90 s and the one before done 5 min', async () => {
    const root = project();
    try {
      const t = await turn(root, [{ toolCalls: [call('1', 'write_file', { path: 'site/src/Footer.tsx', content: 'x' })] }, { content: 'Done.' }], { afterEdit: 'check', beforeDone: 'build' }, [true]);
      assert.deepEqual(t.limits, [90_000, 300_000]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets the answer stand when nothing changed since a failed check', async () => {
    const root = project();
    try {
      const t = await turn(root, [
        { toolCalls: [call('1', 'write_file', { path: 'site/src/Footer.tsx', content: 'x' })] },
        { content: 'Done.' },
        { content: 'I cannot fix the build: it needs a network font.' },
      ], { beforeDone: 'build' }, [false]);
      assert.deepEqual(t.ran, ['write_file', 'npm run build in site'], 'not run again with nothing new to check');
      assert.equal(t.result.answer, 'I cannot fix the build: it needs a network font.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not run when the turn changed no files', async () => {
    const root = project();
    try {
      const t = await turn(root, [{ toolCalls: [call('1', 'read_file', { path: 'site/package.json' })] }, { content: 'It uses Next.js.' }], { beforeDone: 'build' }, []);
      assert.deepEqual(t.ran, ['read_file']);
      assert.equal(t.result.answer, 'It uses Next.js.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
