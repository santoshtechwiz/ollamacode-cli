// agent.afterEdit / agent.beforeDone "auto": ocode picks the checks from what changed, what the project is, and how
// long each check took here before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { ROLE } from '../src/protocol';
import { autoVerbs, FAST_CHECK_MS } from '../src/agent/turn/check-plan';
import type { StackInfo } from '../src/types';

const ESLINT = { argv: ['npx', 'eslint'], extensions: ['.ts', '.tsx', '.js'] };
const next: StackInfo = { id: 'node', label: 'TypeScript', root: '.', frameworks: ['Next.js'], check: ['tsc'], build: ['npm', 'run', 'build'], fileScoped: { lint: ESLINT } };
const plainTs: StackInfo = { id: 'node', label: 'TypeScript', root: '.', check: ['tsc'], build: ['tsc'], fileScoped: { lint: ESLINT } };
const never = () => undefined;

describe('autoVerbs before done', () => {
  it('builds a framework whose build verifies more than types, and lints the changed files; the build covers the type check', () => {
    assert.deepEqual(autoVerbs('done', next, ['src/app/page.tsx'], never), ['lint', 'build']);
    assert.deepEqual(autoVerbs('done', next, ['src/app/globals.css'], never), ['build'], 'a stylesheet can break a build, and ESLint does not read it');
  });

  it('type-checks and lints a project whose build would add nothing', () => {
    assert.deepEqual(autoVerbs('done', plainTs, ['src/a.ts'], never), ['check', 'lint']);
  });

  it('runs nothing for documentation', () => {
    assert.deepEqual(autoVerbs('done', next, ['README.md'], never), []);
    assert.deepEqual(autoVerbs('done', plainTs, ['docs/notes.md'], never), []);
  });
});

describe('autoVerbs after an edit', () => {
  it('runs only checks known to be fast here; one never run, or slow, waits for the end of the turn', () => {
    assert.deepEqual(autoVerbs('edit', plainTs, ['src/a.ts'], never), []);
    assert.deepEqual(autoVerbs('edit', plainTs, ['src/a.ts'], () => 3_000), ['check', 'lint']);
    assert.deepEqual(autoVerbs('edit', plainTs, ['src/a.ts'], (v) => (v === 'check' ? 55_000 : 3_000)), ['lint']);
    assert.deepEqual(autoVerbs('edit', plainTs, ['src/a.ts'], () => FAST_CHECK_MS), [], 'the limit itself is not fast');
  });

  it('never builds after an edit', () => {
    assert.deepEqual(autoVerbs('edit', next, ['src/app/page.tsx'], () => 1_000), ['check', 'lint']);
  });
});

/** A Next.js project with ESLint, in a workspace folder. */
function project(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-auto-'));
  fs.mkdirSync(path.join(root, 'site/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'site/package.json'), JSON.stringify({ scripts: { build: 'next build' }, dependencies: { next: '16', react: '19' }, devDependencies: { eslint: '9' } }));
  fs.writeFileSync(path.join(root, 'site/tsconfig.json'), '{}');
  return root;
}

async function turn(root: string, state: any, replies: any[], durations: Record<string, number>) {
  const ran: string[] = [];
  const history = new ContextStore({ messages: [{ role: ROLE.USER, content: 'change the page' }], budgetTokens: 8000 });
  let asked = 0;
  await runTurn({
    model: 'test', history, toolsEnabled: true, state,
    config: { maxIterations: 8, afterEdit: 'auto', beforeDone: 'auto' },
    gateway: {
      model: 'test', provider: { id: 'test' },
      async stream() {
        ran.push('ask model');
        const next = replies[asked++] ?? { content: 'Done.' };
        return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
      },
    } as any,
    toolRunner: {
      async run(name: string, args: any) {
        if (name === 'write_file') {
          fs.writeFileSync(path.join(root, args.path), String(args.content));
          state.changes = [...state.changes, { path: args.path }];
          state.mutationCount += 1;
          ran.push('write_file');
          return { result: { ok: true, kind: 'text', display: 'ok' } };
        }
        const verb = /eslint/.test(args.command) ? 'lint' : /build/.test(args.command) ? 'build' : 'check';
        ran.push(`${verb}: ${args.command}`);
        return { result: { ok: true, kind: 'command', display: 'ok', data: { execution: { exitCode: 0 } } }, durationMs: durations[verb] };
      },
    } as any,
  } as any);
  return ran;
}

const write = (id: string, file: string) => ({ toolCalls: [{ id, type: 'function', function: { name: 'write_file', arguments: { path: file, content: id } } }] });

describe('auto in a session', () => {
  it('checks once at the end at first, then after edits only what proved fast, and never repeats a check that passed on the same files', async () => {
    const root = project();
    const state: any = { root, changes: [], mutationCount: 0 };
    try {
      const first = await turn(root, state, [write('1', 'site/src/page.tsx'), { content: 'Done.' }], { lint: 4_000, build: 110_000 });
      assert.deepEqual(first, ['ask model', 'write_file', 'ask model', 'lint: npx eslint src/page.tsx', 'build: npm run build'],
        'nothing timed yet: no check after the edit; lint and build once the model answers');

      const second = await turn(root, state, [write('2', 'site/src/page.tsx'), { content: 'Done.' }], { lint: 4_000, build: 110_000 });
      assert.deepEqual(second, ['ask model', 'write_file', 'lint: npx eslint src/page.tsx', 'ask model', 'build: npm run build'],
        'lint proved fast, so it runs right after the edit; at the end it is not run again on the same files, and the build runs once');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
