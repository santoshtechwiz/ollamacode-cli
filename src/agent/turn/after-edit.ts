// agent.afterEdit: the person's own check (tests, a linter, a type check), run once after any step that changed files.
// It is configuration, not the model's call: it runs without asking, the person sees it as a tool line, and its outcome
// rides on that step's last tool result, so the model reads it where it reads what its edits did.

import fs from 'node:fs';
import path from 'node:path';
import { ROLE, TOOL_NAME } from '../../protocol';
import { holdsProjectMarker, projectFolderOf as nearestProjectFolder } from '../../env/project-layout';
import { CHECK_VERBS, type Verb } from '../../env/languages';
import { detectStacks } from '../../env/tooling/detector';
import type { ToolExecutor } from '../../tool/execution/executor';
import type { TurnCallbacks } from './turn';

type Message = import('../../types.ts').Message;

/** Output lines kept from a failed check: the end of a test run is where the failures are. */
const FAILURE_TAIL_LINES = 40;

/**
 * The folder of the project a changed file belongs to, workspace-relative; '' for the root. A root that is a project
 * itself (a monorepo, a solution) runs its own check, which covers its packages: their folders may have none. Otherwise
 * it is the nearest folder at or above the file that holds a project marker (package.json, go.mod, Cargo.toml, a
 * .csproj …). Run at a root that is no project, a project's check fails there, and a model once made a fake root
 * package.json whose test script printed "No tests" so the check would pass.
 */
export function projectFolderOf(root: string, rel: string): string {
  const top = path.resolve(root);
  if (holdsProjectMarker(top)) return '';
  // A folder the step deleted holds no marker, so the search goes on above it.
  const found = nearestProjectFolder(top, path.resolve(top, rel));
  return found ? path.relative(top, found).split(path.sep).join('/') : '';
}

/** A project's own command, by name: "check", "build", "test" or "lint" is the one ocode detected for its stack. */
const isCheckVerb = (word: string): word is Verb => (CHECK_VERBS as readonly string[]).includes(word);

/**
 * The commands a setting names: words that are all verbs ("check lint") are one command each, run in that order;
 * anything else is one command as written ("npm test", "pytest -q").
 */
export function checkCommands(setting: string): string[] {
  const words = setting.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every(isCheckVerb) ? words : setting.trim() ? [setting.trim()] : [];
}

/**
 * The command to run in this folder: the configured one as written, or the project's own for a check named by verb.
 * A verb whose command takes files (ESLint, ruff) is given only the changed ones, which keeps it fast enough to run
 * after every step. '' when there is nothing for it to look at.
 */
async function projectCommand(command: string, folder: string, files: string[]): Promise<string | null> {
  if (!isCheckVerb(command)) return command;
  const stacks = await detectStacks(folder).catch((): import('../../types.ts').StackInfo[] => []);
  const quote = (argv: string[]) => argv.map((a) => (/^[\w@./:=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
  const byFile = stacks.map((stack) => stack.fileScoped?.[command]).find(Boolean);
  if (byFile) {
    const scoped = files.filter((f) => byFile.extensions.includes(path.extname(f).toLowerCase()));
    return scoped.length ? quote([...byFile.argv, ...scoped]) : '';
  }
  const argv = stacks.map((stack) => stack[command]).find((a) => Array.isArray(a) && a.length);
  return argv ? quote(argv) : null;
}

interface CheckRun {
  /** The tool call made, as the model and the person see it. */
  args: { command: string; cwd?: string };
  result: import('../../types.ts').ToolResult;
  passed: boolean;
  note: string;
}

/**
 * Runs each command the setting names, once per project the changed files belong to, in that project's folder.
 * `setting` names it in what the model reads (agent.afterEdit, agent.beforeDone).
 */
async function runChecks({ command, setting, name, root, changed, toolRunner, callbacks, signal }: {
  command: string;
  setting: string;
  /** How a note names the check: "After-edit check". */
  name: string;
  root: string;
  changed: string[];
  toolRunner: ToolExecutor;
  callbacks: TurnCallbacks;
  signal?: AbortSignal;
}): Promise<{ notes: string[]; runs: CheckRun[] }> {
  const byFolder = new Map<string, string[]>();
  for (const rel of changed.length ? changed : ['.']) {
    const folder = projectFolderOf(root, rel);
    const inFolder = path.relative(path.resolve(root, folder), path.resolve(root, rel)).split(path.sep).join('/');
    byFolder.set(folder, [...(byFolder.get(folder) ?? []), ...(rel === '.' ? [] : [inFolder])]);
  }
  const notes: string[] = [];
  const runs: CheckRun[] = [];
  // Two words can name one command (Go's check and lint are both go vet): it runs once per folder.
  const ran = new Set<string>();
  for (const each of checkCommands(command)) {
    for (const [folder, files] of byFolder) {
      const where = folder ? ` in ${folder}` : '';
      const run = await projectCommand(each, path.resolve(root, folder), files.filter((f) => fs.existsSync(path.resolve(root, folder, f))));
      if (run === '' || (run && ran.has(`${folder}\u0000${run}`))) continue;
      if (run) ran.add(`${folder}\u0000${run}`);
      if (!run) {
        notes.push(`${name} (${setting} "${each}")${where} did not run: this project has no ${each} command ocode knows.`);
        continue;
      }
      const args = folder ? { command: run, cwd: folder } : { command: run };
      callbacks.onToolStart?.(TOOL_NAME.EXEC_SHELL, args);
      const { result } = await toolRunner.run(TOOL_NAME.EXEC_SHELL, args, { signal, approve: async () => true });
      callbacks.onToolResult?.(TOOL_NAME.EXEC_SHELL, args, result);
      const data = result.data as { execution?: { exitCode?: number }; background?: boolean; id?: string } | undefined;
      const exit = data?.execution?.exitCode;
      const output = String(result.display ?? result.error ?? '').split('\n').slice(-FAILURE_TAIL_LINES).join('\n').trim();
      // Passed means it ran to the end and exited 0; a check still running in the background has not passed yet.
      const passed = !data?.background && result.ok && (exit === undefined || exit === 0);
      const note = data?.background
        ? `${name} \`${run}\`${where} (${setting}) did not finish: it kept running, so it was moved to the background${data.id ? ` as ${data.id}` : ''}; its result is not known.`
        : passed
          ? `${name} \`${run}\`${where} (${setting}) passed.`
          : `${name} \`${run}\`${where} (${setting}) failed${exit !== undefined ? ` with exit ${exit}` : ''}:\n${output}`;
      notes.push(note);
      runs.push({ args, result, passed, note });
    }
  }
  return { notes, runs };
}

/** agent.afterEdit: run after a step that changed files; the outcome rides on that step's last tool result. */
export async function runAfterEditCheck({ command, root, changed, history, toolRunner, callbacks, signal }: {
  command: string;
  /** The workspace root, and the files the step changed, workspace-relative. */
  root: string;
  changed: string[];
  history: { messages: readonly Message[] };
  toolRunner: ToolExecutor;
  callbacks: TurnCallbacks;
  signal?: AbortSignal;
}): Promise<void> {
  const { notes } = await runChecks({ command, setting: 'agent.afterEdit', name: 'After-edit check', root, changed, toolRunner, callbacks, signal });
  if (notes.length === 0) return;
  // The step's last result carries it: the model reads what its edits caused next to what they did.
  const messages = history.messages as Message[];
  const at = messages.findLastIndex((m) => m.role === ROLE.TOOL);
  if (at >= 0) messages[at] = { ...messages[at], content: `${messages[at].content}\n\n${notes.join('\n\n')}` };
}

/**
 * agent.beforeDone: run when the model answers after changing files, so "done" is checked the way the person asked
 * (a build that prerenders pages catches what a type check cannot). The checks that failed come back for the turn to
 * record as calls ocode made, so the model reads why the work is not done yet.
 */
export async function runBeforeDoneCheck({ command, root, changed, toolRunner, callbacks, signal }: {
  command: string;
  root: string;
  changed: string[];
  toolRunner: ToolExecutor;
  callbacks: TurnCallbacks;
  signal?: AbortSignal;
}): Promise<CheckRun[]> {
  const { runs } = await runChecks({ command, setting: 'agent.beforeDone', name: 'Check before answering', root, changed, toolRunner, callbacks, signal });
  return runs.filter((r) => !r.passed);
}
