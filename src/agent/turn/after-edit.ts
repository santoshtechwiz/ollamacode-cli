// agent.afterEdit: the person's own check (tests, a linter, a type check), run once after any step that changed files.
// It is configuration, not the model's call: it runs without asking, the person sees it as a tool line, and its outcome
// rides on that step's last tool result, so the model reads it where it reads what its edits did.

import fs from 'node:fs';
import path from 'node:path';
import { ROLE, TOOL_ERROR_CODE, TOOL_NAME } from '../../protocol';
import { holdsProjectMarker, projectFolderOf as nearestProjectFolder } from '../../env/project-layout';
import { CHECK_VERBS, type Verb } from '../../env/languages';
import { detectStacks } from '../../env/tooling/detector';
import { autoVerbs, type CheckPhase } from './check-plan';
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
function projectCommand(command: string, stacks: import('../../types.ts').StackInfo[], files: string[]): string | null {
  if (!isCheckVerb(command)) return command;
  const quote = (argv: string[]) => argv.map((a) => (/^[\w@./:=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
  const byFile = stacks.map((stack) => stack.fileScoped?.[command]).find(Boolean);
  if (byFile) {
    const scoped = files.filter((f) => byFile.extensions.includes(path.extname(f).toLowerCase()));
    return scoped.length ? quote([...byFile.argv, ...scoped]) : '';
  }
  const argv = stacks.map((stack) => stack[command]).find((a) => Array.isArray(a) && a.length);
  return argv ? quote(argv) : null;
}

/** The setting that lets ocode choose the checks (see check-plan.ts). */
export const AUTO = 'auto';

/** What a session remembers about its checks: how long each took per project, and which passed on the current files. */
export interface CheckMemory {
  /** Last duration of a verb in a project folder, ms; key `${folder}\0${verb}`. */
  checkMs?: Record<string, number>;
  /** The change count a command last passed at; key `${folder}\0${command}`. */
  checkPassedAt?: Record<string, number>;
  changes?: unknown[];
}

/**
 * How long a configured check may run before it is stopped. A check holds the turn while it runs, and in a chat a
 * command has no limit of its own, so a slow linter (ESLint over a Next.js project on a cold Windows cache) held a turn
 * past a minute and a half. A check that runs out of time is unfinished, not failed: nothing in the code is wrong yet.
 * agent.checkTimeoutMs sets both.
 */
const AFTER_EDIT_TIMEOUT_MS = 90_000;
const BEFORE_DONE_TIMEOUT_MS = 300_000;

export interface CheckRun {
  /** The tool call made, as the model and the person see it. */
  args: { command: string; cwd?: string; timeout_ms: number };
  result: import('../../types.ts').ToolResult;
  passed: boolean;
  /** It ran out of time or was moved to the background: its result is not known. */
  unfinished: boolean;
  note: string;
}

/**
 * Runs each command the setting names, once per project the changed files belong to, in that project's folder.
 * `setting` names it in what the model reads (agent.afterEdit, agent.beforeDone).
 */
async function runChecks({ command, phase, memory, setting, name, timeoutMs, root, changed, toolRunner, callbacks, signal }: {
  command: string;
  phase: CheckPhase;
  memory?: CheckMemory;
  timeoutMs: number;
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
  const auto = command.trim() === AUTO;
  // The files as they are now: a check that passed on them need not run again until something changes.
  const stamp = memory?.changes?.length;
  const notes: string[] = [];
  const runs: CheckRun[] = [];
  for (const [folder, allFiles] of byFolder) {
    const where = folder ? ` in ${folder}` : '';
    const files = allFiles.filter((f) => fs.existsSync(path.resolve(root, folder, f)));
    const stacks = await detectStacks(path.resolve(root, folder)).catch((): import('../../types.ts').StackInfo[] => []);
    const timeKey = (verb: string) => `${folder}\u0000${verb}`;
    const verbs = auto
      ? [...new Set(stacks.flatMap((stack) => autoVerbs(phase, stack, files, (verb) => memory?.checkMs?.[timeKey(verb)])))]
      : checkCommands(command);
    // Two words can name one command (Go's check and lint are both go vet): it runs once per folder.
    const ran = new Set<string>();
    for (const each of verbs) {
      const run = projectCommand(each, stacks, files);
      if (run === '' || (run && ran.has(run))) continue;
      if (!run) {
        notes.push(`${name} (${setting} "${each}")${where} did not run: this project has no ${each} command ocode knows.`);
        continue;
      }
      ran.add(run);
      if (auto && stamp !== undefined && memory?.checkPassedAt?.[timeKey(run)] === stamp) continue;
      const args = folder ? { command: run, cwd: folder, timeout_ms: timeoutMs } : { command: run, timeout_ms: timeoutMs };
      callbacks.onToolStart?.(TOOL_NAME.EXEC_SHELL, args);
      const { result, durationMs } = await toolRunner.run(TOOL_NAME.EXEC_SHELL, args, { signal, approve: async () => true });
      callbacks.onToolResult?.(TOOL_NAME.EXEC_SHELL, args, result);
      const data = result.data as { execution?: { exitCode?: number }; background?: boolean; id?: string } | undefined;
      const exit = data?.execution?.exitCode;
      const output = String(result.display ?? result.error ?? '').split('\n').slice(-FAILURE_TAIL_LINES).join('\n').trim();
      // Passed means it ran to the end and exited 0; a check still running in the background has not passed yet.
      const timedOut = result.code === TOOL_ERROR_CODE.ETIMEDOUT;
      const unfinished = Boolean(data?.background) || timedOut;
      const passed = !unfinished && result.ok && (exit === undefined || exit === 0);
      if (memory && isCheckVerb(each)) {
        // A check that ran out of time took at least that long: it is not fast, whatever it would have taken.
        (memory.checkMs ??= {})[timeKey(each)] = unfinished ? Math.max(durationMs ?? 0, timeoutMs) : durationMs ?? 0;
      }
      if (memory && passed && stamp !== undefined) (memory.checkPassedAt ??= {})[timeKey(run)] = stamp;
      const note = data?.background
        ? `${name} \`${run}\`${where} (${setting}) did not finish: it kept running, so it was moved to the background${data.id ? ` as ${data.id}` : ''}; its result is not known.`
        : timedOut
          ? `${name} \`${run}\`${where} (${setting}) did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped; its result is not known. agent.checkTimeoutMs gives it longer.`
          : passed
          ? `${name} \`${run}\`${where} (${setting}) passed.`
          : `${name} \`${run}\`${where} (${setting}) failed${exit !== undefined ? ` with exit ${exit}` : ''}:\n${output}`;
      notes.push(note);
      runs.push({ args, result, passed, unfinished, note });
    }
  }
  return { notes, runs };
}

/** agent.afterEdit: run after a step that changed files; the outcome rides on that step's last tool result. */
export async function runAfterEditCheck({ command, timeoutMs = AFTER_EDIT_TIMEOUT_MS, memory, root, changed, history, toolRunner, callbacks, signal }: {
  command: string;
  timeoutMs?: number;
  memory?: CheckMemory;
  /** The workspace root, and the files the step changed, workspace-relative. */
  root: string;
  changed: string[];
  history: { messages: readonly Message[] };
  toolRunner: ToolExecutor;
  callbacks: TurnCallbacks;
  signal?: AbortSignal;
}): Promise<void> {
  const { notes } = await runChecks({ command, phase: 'edit', memory, setting: 'agent.afterEdit', name: 'After-edit check', timeoutMs, root, changed, toolRunner, callbacks, signal });
  if (notes.length === 0) return;
  // The step's last result carries it: the model reads what its edits caused next to what they did.
  const messages = history.messages as Message[];
  const at = messages.findLastIndex((m) => m.role === ROLE.TOOL);
  if (at >= 0) messages[at] = { ...messages[at], content: `${messages[at].content}\n\n${notes.join('\n\n')}` };
}

/**
 * agent.beforeDone: run when the model answers after changing files, so "done" is checked the way the person asked
 * (a build that prerenders pages catches what a type check cannot). Every check that ran comes back: the turn records
 * the failed ones as calls ocode made, so the model reads why the work is not done yet, and tells the person how it went.
 */
export async function runBeforeDoneCheck({ command, timeoutMs = BEFORE_DONE_TIMEOUT_MS, memory, root, changed, toolRunner, callbacks, signal }: {
  command: string;
  timeoutMs?: number;
  memory?: CheckMemory;
  root: string;
  changed: string[];
  toolRunner: ToolExecutor;
  callbacks: TurnCallbacks;
  signal?: AbortSignal;
}): Promise<CheckRun[]> {
  const { runs } = await runChecks({ command, phase: 'done', memory, setting: 'agent.beforeDone', name: 'Check before answering', timeoutMs, root, changed, toolRunner, callbacks, signal });
  return runs;
}
