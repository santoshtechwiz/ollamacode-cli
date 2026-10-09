// `npm run replay -- <session.json>`: a saved session's plan and task-list calls, answered again by today's code.
// No model is called and no command runs, so it costs no tokens. The model's calls are replayed as it made them;
// plan and task-list tools run for real on a scratch workspace; every other call keeps its recorded result, and what
// it did to the files (a write, a passing or failing command) is applied to the session state the task rules read.
// After the first call that now answers differently, the model would have gone another way: from there it shows what
// today's code says to the same calls, not what the model would have done.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '../src/tool/index';
import presentPlan from '../src/agent/planning/present-plan.tool';
import todoWrite from '../src/agent/planning/todo-write.tool';
import enterPlanMode from '../src/agent/planning/enter-plan-mode.tool';
import { createWorkspaceState, noteFailed, notePassed } from '../src/context/workspace-state';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run replay -- <session.json>');
  process.exit(2);
}
const session = JSON.parse(fs.readFileSync(file, 'utf8'));
const messages: any[] = session.messages ?? [];
const recorded = new Map(messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, String(m.content ?? '')]));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-replay-'));
const state: any = Object.assign(createWorkspaceState(root), { autoFixAuthorized: true });
// The plan's answer as the person gave it: approved, changes asked, or not now.
const answerOf = (text: string) => (/approved this plan/.test(text) ? 'Yes, start now' : /asked for changes: (.*)/.exec(text)?.[1] ?? 'Not yet');

const REPLAYED: Record<string, any> = { todo_write: todoWrite, present_plan: presentPlan, enter_plan_mode: enterPlanMode };
// What the tool said, without what the recording adds around it: the error code, and the note a repeated call gets.
const said = (text: string) => text.split('\n')[0]
  .replace(/^(OK|ERROR) (\S+)(?: \[\w+\])? — /, '$1 $2 — ')
  .replace(/— \S+ was already called with exactly these arguments and rejected: /, '— ');
const shown = (text: string) => (text.length > 320 ? `${text.slice(0, 320)}…` : text);
const verdict = (text: string) => (text.startsWith('ERROR') ? 'refused' : 'ok');
let changed = 0;
let refusedThen = 0;
let refusedNow = 0;

for (const [index, message] of messages.entries()) {
  if (message.role === 'user') console.log(`\n#${index} person: ${String(message.content).slice(0, 100)}`);
  for (const call of message.tool_calls ?? []) {
    const name = call.function?.name;
    const args = call.function?.arguments ?? {};
    const then = recorded.get(call.id) ?? '';
    const tool = REPLAYED[name];
    if (!tool) {
      // Not replayed: what it did to the work is what the task rules read.
      if (/^(OK|Created|Edited|Overwrote)/.test(then) && ['write_file', 'edit_file', 'delete_file'].includes(name)) state.note('write', String(args.path ?? ''), 'file');
      if (name === 'exec_shell' && !args.background) {
        const cwd = path.resolve(root, String(args.cwd ?? '.'));
        if (/^OK exec_shell/.test(then)) notePassed(state, cwd, String(args.command ?? ''));
        else if (/\[EEXIT\]/.test(then)) noteFailed(state, cwd, String(args.command ?? ''));
      }
      continue;
    }
    const result = await tool.execute(args, { state, root, cwd: root, ask: async () => answerOf(then) } as any);
    // The model reads a result's note to it where there is one; the recording holds that.
    const now = result.ok ? `OK ${name} — ${result.modelNote ?? result.display ?? ''}` : `ERROR ${name} — ${result.error}`;
    if (verdict(then) === 'refused') refusedThen++;
    if (verdict(now) === 'refused') refusedNow++;
    const same = said(then) === said(now);
    if (!same) changed++;
    console.log(`#${index} ${name}${same ? '' : '   ← answers differently now'}`);
    if (same) continue;
    console.log(`   then: ${shown(said(then))}`);
    console.log(`   now:  ${shown(said(now))}`);
  }
}

const list = (lines: string[]) => (lines.length ? lines.map((line) => `  ${line.slice(0, 120)}`).join('\n') : '  (none)');
const lastThen = [...messages].reverse().find((m) => m.role === 'tool' && /^OK todo_write/.test(String(m.content ?? '')));
const thenList = lastThen ? String(lastThen.content).replace(/^OK todo_write — /, '').split('\n').filter((l) => /^\[[x~ ]\]/.test(l)) : [];
const { todoLines } = await import('../src/agent/todos');
console.log(`\ntask list then:\n${list(thenList)}`);
console.log(`task list now:\n${list(todoLines(state.todos ?? []))}`);
console.log(`\n${changed} call(s) answered differently · task-list calls refused: ${refusedThen} then, ${refusedNow} now`);
fs.rmSync(root, { recursive: true, force: true });
