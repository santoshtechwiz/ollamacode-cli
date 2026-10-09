// agent.afterEdit: the person's check runs once after a step that changed files, and the model reads its result.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { ROLE } from '../src/protocol';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectFolderOf } from '../src/agent/turn/after-edit';

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

  it('a passing check is one short line', async () => {
    const t = await turn([{ toolCalls: [call('1', 'write_file', { path: 'a.js', content: 'x' })] }, { content: 'Done.' }], 'npm test', true);
    assert.match(toolMessages(t.requests[1]).at(-1)!, /After-edit check `npm test` \(agent\.afterEdit\) passed\.$/);
  });

  it('runs nothing when it is not set', async () => {
    const t = await turn([{ toolCalls: [call('1', 'write_file', { path: 'a.js', content: 'x' })] }, { content: 'Done.' }]);
    assert.deepEqual(t.ran, ['write_file']);
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

  it('a root that is a project itself runs its own check, even for a file in one of its packages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-after-mono-'));
    try {
      fs.mkdirSync(path.join(root, 'packages', 'x', 'src'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), '{"workspaces":["packages/*"]}');
      fs.writeFileSync(path.join(root, 'packages', 'x', 'package.json'), '{}');
      assert.equal(projectFolderOf(root, 'packages/x/src/a.js'), '');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a check that kept running and went to the background has not passed', async () => {
    const t = await turn([{ toolCalls: [call('1', 'write_file', { path: 'a.js', content: 'x' })] }, { content: 'Done.' }], 'npm test', 'background');
    const note = toolMessages(t.requests[1]).at(-1)!;
    assert.match(note, /did not finish: it kept running, so it was moved to the background as npm-test; its result is not known\./);
    assert.doesNotMatch(note, /passed/);
  });

  it('"build" runs each changed project\'s own build: the TypeScript check in a Node project, dotnet build in a .NET one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-ae-verb-'));
    try {
      fs.mkdirSync(path.join(root, 'api'));
      fs.writeFileSync(path.join(root, 'api', 'package.json'), JSON.stringify({ name: 'api', scripts: {} }));
      fs.writeFileSync(path.join(root, 'api', 'tsconfig.json'), '{}');
      fs.mkdirSync(path.join(root, 'billing'));
      fs.writeFileSync(path.join(root, 'billing', 'Billing.csproj'), '<Project Sdk="Microsoft.NET.Sdk"></Project>');
      const t = await turn([
        { toolCalls: [call('1', 'write_file', { path: 'api/src/a.ts', content: 'x' }), call('2', 'write_file', { path: 'billing/A.cs', content: 'y' })] },
        { content: 'Done.' },
      ], 'build', true, root);
      assert.ok(t.ran.includes('exec_shell: npx tsc --noEmit in api'), t.ran.join(' | '));
      assert.ok(t.ran.some((r) => r.startsWith('exec_shell: dotnet build') && r.endsWith('in billing')), t.ran.join(' | '));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
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
