// The plan flow end to end, without a model: what the person sees at approval, while it runs, and when it ends,
// and what is left on disk. Each of these was a bug seen in a live session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// The plan store lives under the ocode home: point it at a scratch folder before anything loads it.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-plan-flow-'));
process.env.OLLAMACODE_HOME = HOME;

const { renderMarkdown } = await import('../src/ui/render/markdown.ts');
const { createOnPlanFn } = await import('../src/cli/chat/turn/plan-service.ts');
const { reportChatTurn } = await import('../src/cli/chat/turn/index.ts');
const { describeToolResult } = await import('../src/ui/tool-preview.ts');
const { noteCommandRan, planChecklist, liveChecklist } = await import('../src/agent/planning/plan.ts');
const store = await import('../src/agent/planning/store.ts');
const { STOP_REASONS } = await import('../src/protocol.ts');

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

function reporter() {
  const notes: string[] = [];
  const plans: string[] = [];
  const host: any = {
    render: {
      text: '',
      markdown: () => {},
      note: (m: string) => notes.push(m),
      plan: (t: string) => plans.push(t),
      commitTasks: () => {},
    },
    workspace: { state: { autoFixAuthorized: true } },
    interactive: false,
    flags: {},
  };
  return { host, notes, plans };
}

describe('approval view', () => {
  it("shows the model's own plan text once, not a re-parsed copy", async () => {
    const { host, plans } = reporter();
    const presented = '## Goal\nA REST API\n\n## Implementation\n- **Create** the project\n  - `dotnet new webapi`';
    const decision = await createOnPlanFn(host, new AbortController().signal)({
      summary: 'x', steps: ['Create the project'], files: { create: [], edit: [], del: [] }, raw: 'Goal: x', presented,
    } as any);
    assert.equal(decision.decision, 'approve');
    assert.deepEqual(plans, [presented]);
  });

  it('numbers top-level steps in order and keeps nested items as bullets', () => {
    const out = plain(renderMarkdown('1. Init project\n   - Run dotnet new\n   - Why: baseline\n2. Add Swagger\n3. Build').join('\n'));
    assert.match(out, /1\. Init project/);
    assert.match(out, /2\. Add Swagger/);
    assert.match(out, /3\. Build/);
    assert.ok(!/[4-9]\./.test(out), `nested items were numbered as steps:\n${out}`);
    assert.ok(!/^\s*\* /m.test(out), `a raw * bullet leaked:\n${out}`);
  });
});

describe('the ending', () => {
  const summary = (over: Record<string, unknown>) => ({ title: 'api', done: 3, total: 3, notDone: [], files: ['a.cs', 'b.cs'], ran: ['dotnet build'], ...over });

  it('a finished plan is one line', async () => {
    const { host, notes } = reporter();
    await reportChatTurn(host, { content: 'Done.', toolResults: [], iterations: 1, stopReason: STOP_REASONS.COMPLETE, planSummary: summary({}) } as any, {});
    const plan = notes.filter((n) => n.startsWith('Plan'));
    assert.deepEqual(plan, ['Plan finished 🎉  3/3 steps · 2 files changed · dotnet build']);
  });

  it('a partly done plan names at most three steps left', async () => {
    const { host, notes } = reporter();
    const notDone = ['Run **migrations**', 'Verify Swagger', 'Add tests', 'Add docs'];
    await reportChatTurn(host, { content: 'Done.', toolResults: [], iterations: 1, stopReason: STOP_REASONS.COMPLETE, planSummary: summary({ done: 2, total: 6, notDone }) } as any, {});
    assert.ok(notes.some((n) => n.startsWith('Plan finished  2/6 steps')), notes.join(' | '));
    assert.ok(notes.includes('left: Run migrations, Verify Swagger, Add tests +1 more'), notes.join(' | '));
  });

  it('a plan where nothing was done says so plainly', async () => {
    const { host, notes } = reporter();
    await reportChatTurn(host, { content: 'Would you like me to start?', toolResults: [], iterations: 1, stopReason: STOP_REASONS.COMPLETE, planSummary: summary({ done: 0, total: 5, files: [], ran: [] }) } as any, {});
    assert.ok(notes.includes('Nothing from the plan was done. /continue to start it, or /plan close to drop it.'), notes.join(' | '));
    assert.ok(!notes.some((n) => n.startsWith('Plan finished')));
  });
});

describe('pausing and permissions', () => {
  it('a paused plan says where it stopped and what to do, in one line', async () => {
    const { host, notes } = reporter();
    const planChecklist = [{ title: 'Init', text: 'Init', status: 'open' }, { title: 'Build', text: 'Build', status: 'open' }];
    await reportChatTurn(host, { content: '', toolResults: [{ name: 'todo_write', args: {}, result: { ok: true, kind: 'status', data: { reused: true } } }], iterations: 3, stopReason: STOP_REASONS.GUARD_STUCK, planChecklist, planRemaining: 2 } as any, {});
    const stopLines = notes.filter((n) => /paused|stopped/i.test(n));
    assert.deepEqual(stopLines, ['Plan paused — 0 of 2 steps done. The model repeated the same step — tell it what to do next, type /continue to retry, or /plan close to drop it.']);
  });

  it('a plan stuck on a failing command names the command and what it said', async () => {
    const { host, notes } = reporter();
    const planChecklist = [{ title: 'Create Dockerfile', text: 'Create Dockerfile', status: 'done' }, { title: 'Run docker build', text: 'Run docker build', status: 'open' }];
    const build = {
      name: 'exec_shell',
      args: { command: 'docker build -t demorefactored DemoRefactored' },
      result: { ok: false, kind: 'command', code: 'EEXIT', error: 'Command exited with code 1', data: { execution: { stderr: '\nerror during connect: Docker Desktop is not running\n' } } },
    };
    await reportChatTurn(host, { content: '', toolResults: [build, build], iterations: 3, stopReason: STOP_REASONS.GUARD_STUCK, planChecklist, planRemaining: 1 } as any, {});
    const stopLines = notes.filter((n) => /paused|stopped/i.test(n));
    assert.deepEqual(stopLines, ['Plan paused — 1 of 2 steps done. Stopped at `docker build -t demorefactored DemoRefactored`: error during connect: Docker Desktop is not running. Fix that, then type /continue, or /plan close to drop it.']);
  });

  it('quotes what a framed error says, not the frame around it', async () => {
    const { host, notes } = reporter();
    const planChecklist = [{ title: 'Init', text: 'Init', status: 'done' }, { title: 'Validate', text: 'Validate', status: 'open' }];
    const validate = {
      name: 'exec_shell',
      args: { command: 'terraform validate' },
      result: { ok: false, kind: 'command', code: 'EEXIT', error: 'Command exited with code 1', data: { execution: { stderr: '╷\n│ Error: Unsupported argument\n│\n│   on main.tf line 4\n╵\n' } } },
    };
    await reportChatTurn(host, { content: '', toolResults: [validate], iterations: 3, stopReason: STOP_REASONS.GUARD_STUCK, planChecklist, planRemaining: 1 } as any, {});
    assert.ok(notes.some((n) => n.includes('Stopped at `terraform validate`: Error: Unsupported argument.')), notes.join(' | '));
  });

  it('updating the task list never asks for approval', async () => {
    const { PermissionPolicy, createPermissions } = await import('../src/tool/policy/permission-policy.ts');
    const { TOOL_META } = await import('../src/tool/index.ts');
    const decision = await new PermissionPolicy().decide({
      toolName: 'todo_write', args: { todos: [] }, toolDef: TOOL_META.todo_write, cwd: process.cwd(), root: process.cwd(),
      permissions: createPermissions(), yes: false, policy: 'ask', interactive: true,
    } as any);
    assert.equal(decision, 'allow');
  });

  it('a run step is titled with its verb once', () => {
    const plan: any = { summary: 'x', steps: ['Run: Run dotnet run and check the output'], files: { create: [], edit: [], del: [] }, raw: '' };
    assert.equal(planChecklist(plan, []).map((i: any) => i.title)[0], 'Run dotnet run and check the output');
  });
});

describe('a task list without a plan', () => {
  it('ends the turn with its final state printed once', async () => {
    const committed: any[] = [];
    const { host } = reporter();
    host.render.commitTasks = (list: any[]) => committed.push(list);
    const list = (n: number) => [
      { content: 'GET /todos', status: n > 0 ? 'completed' : 'pending' },
      { content: 'POST /todos', status: n > 1 ? 'completed' : 'in_progress' },
    ];
    const toolResults = [
      { name: 'todo_write', args: {}, result: { ok: true, kind: 'status', data: { todos: list(0) } } },
      { name: 'edit_file', args: {}, result: { ok: true, kind: 'file' } },
      { name: 'todo_write', args: {}, result: { ok: true, kind: 'status', data: { todos: list(2) } } },
    ];
    await reportChatTurn(host, { content: 'Done.', toolResults, iterations: 2, stopReason: STOP_REASONS.COMPLETE } as any, {});
    assert.equal(committed.length, 1, 'one final list, not one per update');
    assert.deepEqual(committed[0].map((i: any) => i.status), ['done', 'done']);
  });
});

describe('what the screen never shows', () => {
  const shown = (name: string, result: any) => {
    const v = describeToolResult(name, result);
    return { v, text: plain([v.title, ...(v.detail ?? [])].join('\n')) };
  };

  it('a reused result is one quiet line', () => {
    const { v, text } = shown('grep_content', { ok: true, kind: 'text', display: 'Reused — grep_content already ran with these exact arguments this turn. The tool was not run again.\nsrc/a.js:1', data: { reused: true } });
    assert.equal(v.neutral, true);
    assert.ok(!text.includes('Reused —'), text);
  });

  it('a refused repeat hides the advice meant for the model', () => {
    const { v, text } = shown('write_file', { ok: false, kind: 'text', code: 'EDENIED', error: 'write_file was already tried this turn', hint: 'Do not call it again; ask the user with ask_user.', data: { notRunRepeat: true } });
    assert.equal(v.neutral, true);
    assert.ok(!/ask_user|Do not call/.test(text + (v.hint ?? '')), text);
  });

  it('a malformed call shows no schema text', () => {
    const { v, text } = shown('exec_shell', { ok: false, kind: 'text', code: 'EINVAL', error: 'Invalid argument(s): sandbox must be one of: none, read-only', hint: 'Resend as {...}' });
    assert.equal(v.neutral, true);
    assert.ok(!/Invalid argument|sandbox|Resend/.test(text), text);
  });
});

describe('the live checklist', () => {
  // The steps of a real session's plan, as the person saw them, ticked before anything had run.
  const RAG_STEPS = [
    'Create Virtual Environment: Isolate dependencies to avoid conflicts.',
    'Install Dependencies:',
    'Ingestion: Load a document (PDF or Text) using PyPDFLoader or TextLoader.',
    'Chunking: Use RecursiveCharacterTextSplitter to break the text into overlapping chunks (e.g., 1000 characters with 200 overlap) to preserve context.',
    'Embedding & Storage:',
    'Retrieval & Generation:',
    'Prompt Template: I will define a custom prompt to ensure the LLM only answers based on the provided context.',
    'Configuration: Use a .env file for the OPENAI_API_KEY.',
    'Knowledge Base: Use the existing knowledge.txt or a new PDF.',
    'Execution: Run the script: python rag.py.',
    'Verification: Ask a specific question about the document to verify the retrieval accuracy.',
  ];
  const ragPlan = (): any => ({ summary: 'rag', steps: [...RAG_STEPS], files: { create: [], edit: [], del: [] }, raw: 'x' });

  it('ticks nothing before anything has run, even with older changes in the session', () => {
    // knowledge.txt and .env were changed earlier in the session, before this plan was approved.
    const state = { changes: [{ op: 'edit', path: 'knowledge.txt' }, { op: 'create', path: '.env' }] as any[] };
    const items = liveChecklist(ragPlan(), state, 2);
    assert.deepEqual(items.map((i: any) => i.status), ['active', ...Array(RAG_STEPS.length - 1).fill('open')]);
  });

  it('shows short step titles, not paragraphs', () => {
    const titles = liveChecklist(ragPlan(), { changes: [] }, 0).map((i: any) => i.title);
    assert.deepEqual(titles.slice(0, 4), ['Create Virtual Environment', 'Install Dependencies:', 'Ingestion', 'Chunking']);
    assert.ok(titles.every((t: string) => t.length <= 60), titles.join(' | '));
  });

  it("follows the model's own task list when it keeps one", () => {
    const todos = [
      { content: 'Create the venv', status: 'completed' },
      { content: 'Install packages', status: 'in_progress' },
      { content: 'Write rag.py', status: 'pending' },
    ];
    const items = liveChecklist(ragPlan(), { todos, changes: [] }, 0);
    assert.deepEqual(items.map((i: any) => `${i.status} ${i.title}`), ['done Create the venv', 'active Install packages', 'open Write rag.py']);
  });
});

describe('step evidence', () => {
  it('ticks a step that names a file the plan really changed, whatever the file is called', () => {
    const plan: any = {
      steps: ['Create Dockerfile', 'Create .dockerignore', 'Update appsettings.json for container environment', 'Run docker build -t demorefactored DemoRefactored'],
      files: { create: [], edit: [], del: [] },
      runs: [],
    };
    const changes: any[] = [
      { op: 'create', path: 'DemoRefactored/Dockerfile' },
      { op: 'create', path: 'DemoRefactored/.dockerignore' },
      { op: 'edit', path: 'DemoRefactored/appsettings.json' },
    ];
    assert.deepEqual(planChecklist(plan, changes, { running: true }).map((i: any) => i.status), ['done', 'done', 'done', 'active'],
      'three files changed, so three steps are done; the build never ran');
  });

  it('does not tick a step for a file it only mentions in passing as part of a longer name', () => {
    const plan: any = { steps: ['Create Dockerfile.dev'], files: { create: [], edit: [], del: [] }, runs: [] };
    assert.deepEqual(planChecklist(plan, [{ op: 'create', path: 'Dockerfile' }] as any, {}).map((i: any) => i.status), ['open']);
  });
});

describe('run steps', () => {
  it('count when the same script ran from another folder or through a shell wrapper', () => {
    const plan: any = { summary: 'c', steps: ['Run: `c-demo\\build.bat`', 'Run: `c-demo\\run.bat`', 'Run: npm test', 'Run: `c-demo\\other.bat`'], files: { create: [], edit: [], del: [] }, raw: '' };
    noteCommandRan(plan, 'build.bat', 'c-demo');
    noteCommandRan(plan, 'cmd /c .\\c-demo\\run.bat');
    noteCommandRan(plan, 'npm test -- --watch=false');
    assert.deepEqual(planChecklist(plan, []).map((i: any) => i.status), ['done', 'done', 'done', 'open']);
  });
});

describe('plans on disk', () => {
  const make = (workspaceRoot: string, sessionId: string) =>
    store.createPlan({ plan: { summary: 'p', steps: ['a'], files: { create: [], edit: [], del: [] }, raw: '' } as any, task: 'p', workspaceRoot, sessionId });

  it('a deleted plan leaves nothing behind', () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-ws-'));
    const { planPath } = make(ws, 's1');
    assert.ok(store.getActivePlan(ws));
    store.deletePlan(planPath);
    assert.equal(store.getActivePlan(ws), null);
    assert.equal(fs.existsSync(planPath), false);
  });

  it("a new session clears the workspace's old plans", () => {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-ws-'));
    make(ws, 'old-session');
    assert.equal(store.clearWorkspacePlans(ws), 1);
    assert.equal(store.getActivePlan(ws), null);
  });

  it('stale plans are pruned from any workspace: ended, folder gone, or a day old', () => {
    const gone = path.join(os.tmpdir(), `ocode-gone-${Date.now()}`);
    make(gone, 's');
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-ws-'));
    const fresh = make(ws, 's');
    const removed = store.pruneStalePlans();
    assert.ok(removed >= 1);
    assert.ok(store.getActivePlan(ws), 'a fresh plan in an existing folder stays');
    assert.ok(store.pruneStalePlans(Date.now() + 25 * 60 * 60 * 1000) >= 1, 'a day later it goes');
    assert.equal(fs.existsSync(fresh.planPath), false);
  });
});
