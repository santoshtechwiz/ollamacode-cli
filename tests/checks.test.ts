import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { ROLE } from '../src/protocol';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFolderOf, checkCommands } from '../src/agent/turn/after-edit';

describe('after-edit', () => {
  // agent.afterEdit: the person's check runs once after a step that changed files, and the model reads its result.
  const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, type: 'function', function: { name, arguments: args } });

  async function turn(replies: any[], afterEdit?: string, checkPasses: boolean | 'background' = false, root?: string) {
    const requests: any[] = [];
    const ran: string[] = [];
    const state: any = { mutationCount: 0, changes: [], ...(root ? { root } : {}) };
    const history = new ContextStore({ messages: [{ role: ROLE.USER, content: 'do the task' }], budgetTokens: 8000 });
    await runTurn({
      model: 'test', history, toolsEnabled: true, state,
      config: { maxIterations: 6, ...(afterEdit ? { afterEdit } : {}) },
      toolProfile: { always: ['read_file', 'write_file', 'exec_shell'] },
      gateway: {
        model: 'test', provider: { id: 'test' },
        async stream(request: any) {
          requests.push(request);
          const next = replies[requests.length - 1] ?? { content: '' };
          return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
      toolRunner: {
        async run(name: string, args: any) {
          ran.push(name === 'exec_shell' ? `exec_shell: ${args.command}${args.cwd ? ` in ${args.cwd}` : ''}` : name);
          if (name === 'write_file') {
            // As the workspace records it: a file changed again moves to the end as a new entry.
            state.mutationCount += 1;
            state.changes = [...state.changes.filter((c: any) => c.path !== args.path), { path: args.path }];
          }
          if (name === 'exec_shell') {
            if (checkPasses === 'background') {
              return { result: { ok: true, kind: 'command', display: 'is serving at http://localhost:3000', data: { background: true, id: 'npm-test' } } };
            }
            return { result: checkPasses
              ? { ok: true, kind: 'command', display: 'all 12 tests passed', data: { execution: { exitCode: 0 } } }
              : { ok: false, kind: 'command', error: 'Command exited with code 1', display: 'FAIL parse.test.js\n  expected 3, got 2', data: { execution: { exitCode: 1 } } } };
          }
          return { result: { ok: true, kind: 'text', display: 'ok' } };
        },
      } as any,
    } as any);
    return { requests, ran };
  }

  const toolMessages = (request: any) => request.messages.filter((m: any) => m.role === ROLE.TOOL).map((m: any) => String(m.content));

  describe('agent.afterEdit', () => {
    it('runs once after a step that changed files, and the failure reaches the model', async () => {
      const t = await turn([
        { toolCalls: [call('1', 'read_file', { path: 'a.js' })] },
        { toolCalls: [call('2', 'write_file', { path: 'a.js', content: 'x' }), call('3', 'write_file', { path: 'b.js', content: 'y' })] },
        { content: 'Done.' },
      ], 'npm test');
      assert.deepEqual(t.ran, ['read_file', 'write_file', 'write_file', 'exec_shell: npm test'], 'not after the read; once after both writes');
      const seen = toolMessages(t.requests[2]);
      assert.match(seen.at(-1)!, /After-edit check `npm test` \(agent\.afterEdit\) failed with exit 1:\nFAIL parse\.test\.js/);
      assert.doesNotMatch(seen[0], /After-edit/);
    });

    it('runs in the folder of the project whose files changed, not at the workspace root', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-after-'));
      try {
        fs.mkdirSync(path.join(root, 'todo-app', 'src'), { recursive: true });
        fs.writeFileSync(path.join(root, 'todo-app', 'package.json'), '{}');
        assert.equal(projectFolderOf(root, 'todo-app/src/server.js'), 'todo-app');
        assert.equal(projectFolderOf(root, 'notes.txt'), '', 'outside any project: the workspace root');
        const t = await turn([{ toolCalls: [call('1', 'write_file', { path: 'todo-app/src/server.js', content: 'x' })] }, { content: 'Done.' }], 'npm test', true, root);
        assert.deepEqual(t.ran, ['write_file', 'exec_shell: npm test in todo-app']);
        assert.match(toolMessages(t.requests[1]).at(-1)!, /After-edit check `npm test` in todo-app \(agent\.afterEdit\) passed\./);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('runs again when a later step changes a file it already changed', async () => {
      const t = await turn([
        { toolCalls: [call('1', 'write_file', { path: 'a.js', content: 'x' })] },
        { toolCalls: [call('2', 'write_file', { path: 'a.js', content: 'fixed' })] },
        { content: 'Done.' },
      ], 'npm test');
      assert.deepEqual(t.ran, ['write_file', 'exec_shell: npm test', 'write_file', 'exec_shell: npm test']);
    });

    it('a check that kept running and went to the background has not passed', async () => {
      const t = await turn([{ toolCalls: [call('1', 'write_file', { path: 'a.js', content: 'x' })] }, { content: 'Done.' }], 'npm test', 'background');
      const note = toolMessages(t.requests[1]).at(-1)!;
      assert.match(note, /did not finish: it kept running, so it was moved to the background as npm-test; its result is not known\./);
      assert.doesNotMatch(note, /passed/);
    });

    it('"check" in a .NET project compiles away from bin/, which a running app locks; "build" stays its own build', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-ae-dotnet-'));
      try {
        fs.mkdirSync(path.join(root, 'todo'));
        fs.writeFileSync(path.join(root, 'todo', 'Todo.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>');
        const edit = [{ toolCalls: [call('1', 'write_file', { path: 'todo/Program.cs', content: 'x' })] }, { content: 'Done.' }];
        const checked = await turn(edit, 'check', true, root);
        assert.ok(checked.ran.includes('exec_shell: dotnet build -p:BaseOutputPath=obj/ocode-check/ in todo'), checked.ran.join(' | '));
        const built = await turn(edit, 'build', true, root);
        assert.ok(built.ran.includes('exec_shell: dotnet build in todo'), built.ran.join(' | '));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('a project with no such command says so instead of running something else', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-ae-none-'));
      try {
        fs.mkdirSync(path.join(root, 'notes'));
        fs.writeFileSync(path.join(root, 'notes', 'package.json'), JSON.stringify({ name: 'notes', scripts: {} }));
        const t = await turn([{ toolCalls: [call('1', 'write_file', { path: 'notes/a.md', content: 'x' })] }, { content: 'Done.' }], 'lint', true, root);
        assert.ok(!t.ran.some((r) => r.startsWith('exec_shell')), t.ran.join(' | '));
        assert.match(toolMessages(t.requests[1]).join('\n'), /has no lint command ocode knows/);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it('"check" runs each project\'s compile check, whatever its language', async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-ae-check-'));
      try {
        const project = (dir: string, file: string, body: string) => {
          fs.mkdirSync(path.join(root, dir), { recursive: true });
          fs.writeFileSync(path.join(root, dir, file), body);
        };
        project('web', 'package.json', JSON.stringify({ name: 'web', scripts: { build: 'vite build' } }));
        project('web', 'tsconfig.json', '{}');
        project('ml', 'requirements.txt', 'numpy\n');
        project('svc', 'go.mod', 'module svc\n');
        const t = await turn([
          { toolCalls: [
            call('1', 'write_file', { path: 'web/src/a.ts', content: 'x' }),
            call('2', 'write_file', { path: 'ml/train.py', content: 'y' }),
            call('3', 'write_file', { path: 'svc/main.go', content: 'z' }),
          ] },
          { content: 'Done.' },
        ], 'check', true, root);
        const shell = t.ran.filter((r) => r.startsWith('exec_shell'));
        // TypeScript: the type check, not the project's bundling build.
        assert.ok(shell.includes('exec_shell: npx tsc --noEmit in web'), shell.join(' | '));
        // Quoted: its "|" would otherwise be a pipe.
        assert.ok(shell.some((r) => / -m compileall -q -x "venv\|site-packages\|node_modules\|__pycache__" \. in ml$/.test(r)), shell.join(' | '));
        assert.ok(shell.some((r) => /^exec_shell: \S*go vet \.\/\.\.\. in svc$/.test(r)), shell.join(' | '));
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe('before-done', () => {
  // agent.beforeDone checks "done" the way the person asked (a build that prerenders pages), and agent.afterEdit can name
  // several checks, with lint run only on the files that changed.
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
});
