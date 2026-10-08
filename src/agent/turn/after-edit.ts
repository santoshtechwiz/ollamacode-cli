// agent.afterEdit: the person's own check (tests, a linter, a type check), run once after any step that changed files.
// It is configuration, not the model's call: it runs without asking, the person sees it as a tool line, and its outcome
// rides on that step's last tool result, so the model reads it where it reads what its edits did.

import fs from 'node:fs';
import path from 'node:path';
import { ROLE, TOOL_NAME } from '../../protocol';
import { isProjectMarker } from '../../env/languages';
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
  if (holdsMarker(top)) return '';
  let dir = path.dirname(path.resolve(top, rel));
  while (dir.startsWith(top)) {
    if (holdsMarker(dir)) return path.relative(top, dir).split(path.sep).join('/');
    if (dir === top) break;
    dir = path.dirname(dir);
  }
  return '';
}

function holdsMarker(dir: string): boolean {
  try {
    return fs.readdirSync(dir).some((name) => isProjectMarker(name));
  } catch {
    return false; // a folder the step deleted: look above it
  }
}

/** A project's own command, by name: "check", "build", "test" or "lint" is the one ocode detected for its stack. */
const PROJECT_VERBS = new Set(['check', 'build', 'test', 'lint']);

/** The command to run in this folder: the configured one as written, or the project's own for a check named by verb. */
async function projectCommand(command: string, folder: string): Promise<string | null> {
  if (!PROJECT_VERBS.has(command)) return command;
  const stacks = await detectStacks(folder).catch((): import('../../types.ts').StackInfo[] => []);
  const argv = stacks.map((stack) => stack[command as 'check' | 'build' | 'test' | 'lint']).find((a) => Array.isArray(a) && a.length);
  return argv ? argv.map((a) => (/^[\w@./:=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ') : null;
}

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
  // Once per project the step touched, in that project's folder.
  const folders = [...new Set((changed.length ? changed : ['.']).map((rel) => projectFolderOf(root, rel)))];
  const notes: string[] = [];
  for (const folder of folders) {
    const where = folder ? ` in ${folder}` : '';
    const run = await projectCommand(command, path.resolve(root, folder));
    if (!run) {
      notes.push(`After-edit check (agent.afterEdit "${command}")${where} did not run: this project has no ${command} command ocode knows.`);
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
    notes.push(data?.background
      ? `After-edit check \`${run}\`${where} (agent.afterEdit) did not finish: it kept running, so it was moved to the background${data.id ? ` as ${data.id}` : ''}; its result is not known.`
      : result.ok && (exit === undefined || exit === 0)
        ? `After-edit check \`${run}\`${where} (agent.afterEdit) passed.`
        : `After-edit check \`${run}\`${where} (agent.afterEdit) failed${exit !== undefined ? ` with exit ${exit}` : ''}:\n${output}`);
  }

  // The step's last result carries it: the model reads what its edits caused next to what they did.
  const messages = history.messages as Message[];
  const at = messages.findLastIndex((m) => m.role === ROLE.TOOL);
  if (at >= 0) messages[at] = { ...messages[at], content: `${messages[at].content}\n\n${notes.join('\n\n')}` };
}
