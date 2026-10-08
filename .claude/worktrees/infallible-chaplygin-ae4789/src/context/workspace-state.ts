import fs from 'node:fs/promises';
import path from 'node:path';

import { killProcessTree, processManager } from '../env/process/index';
import { classifyFailure, EPHEMERAL_SESSION } from '../protocol';
import { failureImplication } from '../prompts/recovery';
import { logger } from '../core/logger';
import { normalizeRelPath } from '../core/paths';
import { existsSync } from 'node:fs';
import { holdsProjectMarker, projectFolderOf } from '../env/languages';
import { isInside } from '../tool/core/paths';
import { BackgroundInbox, describeExitsForModel } from '../tool/process/background-inbox';
import { taskTodos } from '../agent/planning/todo-write.tool';

const MAX_CHANGES = 50;

const SNAPSHOT_SKIP = new Set([
  'node_modules',
  '.git',
  'venv',
  '.venv',
  'env',
  'dist',
  'build',
  'out',
  '__pycache__',
  '.next',
  'bin',
  'obj',
  '.ollamacode',
]);

const SNAPSHOT_MAX_ENTRIES = 60;

const SNAPSHOT_DEPTH = 2;

const MAX_EXECUTIONS = 40;

const LEDGER_PROMPT_LINES = 12;

export interface FsChange {
  op: string;
  path: string;
  type: 'file' | 'dir';
  /** Its place in the session's sequence of changes (changeSeq when recorded): what a later check covers. */
  seq?: number;
}

export interface Execution {
  name: string;
  summary: string;
  ok: boolean;
  code?: string;
  detail?: string;
  retries?: number;
  /** The request it ran for: a new request starts its own record, a continued one keeps it. */
  taskId?: string;
}

export interface WorkspaceState {
  root: string;

  sessionId: string;

  taskId: string;
  changes: FsChange[];
  executions: Execution[];
  grantedRoots: string[];
  stacks: import('../types.ts').StackInfo[];
  scope: string[];
  activeProject: { id: number; root: string; name: string; } | null;
  /** A plan was shown this turn and not started: nothing changes until the next turn. */
  planHeld?: boolean;
  /** File changes recorded so far; the count when the turn began, and when a build/test/lint/type-check last passed. */
  changeSeq?: number;
  turnStartChanges?: number;
  verifiedAt?: number;
  /** The project this conversation last changed files in (the nearest folder with a project marker), kept by the system. */
  workedProject?: { root: string; name: string } | null;
  index: import('./workspace-index/_shared.ts').IndexHandle | null;
  tooling?: import('../env/tooling/manager.ts').ToolingManager | null;
  questionsAsked: number;
  autoFixAuthorized: boolean;
  mutationCount: number;
  subprocesses: Map<string, import('../tool/process/subprocess-state.ts').SubprocessRecord>;
  /** Background processes that ended on their own, until a turn has shown them to the model. */
  background: BackgroundInbox;
  readFiles: Set<string>;
  /** The version of each file the model last saw, by path, so line numbers it quotes can be checked (see _seen). */
  seenText: Map<string, string>;
  todos: import('../agent/planning/todo-write.tool.ts').TodoItem[];
  /** The task that wrote `todos`; a list from another task is not shown as the running one's. */
  todosTask?: string | null;

  planPath?: string | null;
  reviewOnly?: boolean;
  plan?: import('../agent/planning/plan.ts').Plan | null;
  /** The plan text the model gave present_plan, waiting to be read and put to the user for approval. */
  presentedPlan?: string | null;
  /** The files present_plan listed as the plan's scope, read with presentedPlan. */
  presentedPlanFiles?: string[] | null;
  /** The checklist present_plan gave, read with presentedPlan. */
  presentedPlanSteps?: string[] | null;
  /** True while plan mode explores: present_plan leaves approval to the plan loop then, and asks the person itself otherwise. */
  planExploring?: boolean;
  /** Each plan-mode exploration this session, kept for the saved session record only. */
  planExplorations?: import('../types.ts').Message[][];
  /** Each subagent's conversation this session, kept for the saved session record only. */
  subagentRuns?: import('../agent/subagent/runner.ts').SubagentRun[];
  permissions?: import('../tool/policy/permission-policy.ts').PermissionState;
  agentState?: import('../agent/state.ts').AgentStateBox;
  tunnel?: boolean;
  pendingOutputContinuation?: boolean;
  _projectCache?: string | null;
  _projectCacheKey?: string | null;
  note: (op: string, rel: string, type: 'file' | 'dir') => void;
  record: (entry: Execution) => void;
  grant: (dir: string) => void;
  /** Something outside the file tools (code that ran) may have changed the disk: the world moves, nothing is recorded. */
  touch: () => void;
  startTurn: () => void;
  reset: () => void;
}


const SESSION_UNLOCK = new WeakMap<WorkspaceState, (next: string) => void>();

interface SessionIdentity {
  sessionId: string;
  taskId?: string;
}


export function createWorkspaceState(
  root: string,
  identity: SessionIdentity = { sessionId: EPHEMERAL_SESSION }
): WorkspaceState {
  const base = path.resolve(root);
  let sessionId = identity.sessionId || EPHEMERAL_SESSION;

const state: WorkspaceState = {
    root: base,
    // Replaced by the guarded accessor below; the literal carries it so the shape satisfies WorkspaceState without a cast.
    sessionId,
    taskId: identity.taskId ?? '',
    changes: [],
    executions: [],
    grantedRoots: [],
    stacks: [],
    scope: [],
    activeProject: null,
    index: null,
    tooling: null,
    questionsAsked: 0,
    autoFixAuthorized: false,
    mutationCount: 0,
    subprocesses: new Map(),
    background: new BackgroundInbox(),
    readFiles: new Set(),
    seenText: new Map(),
    todos: [],
    planPath: null,

    note(op, rel, type) {
      const existing = state.changes.findIndex((c) => normalizeRelPath(c.path) === normalizeRelPath(rel) && c.type === type);
      if (existing !== -1) state.changes.splice(existing, 1);
      state.changeSeq = (state.changeSeq ?? 0) + 1;
      state.changes.push({ op, path: rel, type, seq: state.changeSeq });
      if (state.changes.length > MAX_CHANGES) state.changes.shift();
      // Where the work is: a later "this project", a git command or a run with no folder given goes there.
      const project = op === 'delete' ? null : projectFolderOf(state.root, path.resolve(state.root, rel));
      noteWorkIn(state, project);
      state.mutationCount += 1;
      state.index?.onChange?.(op, rel, type);
    },

    record(entry) {
      state.executions.push({ ...entry, taskId: state.taskId });
      if (state.executions.length > MAX_EXECUTIONS) state.executions.shift();
    },

    grant(dir) {
      const abs = path.resolve(dir);
      if (!state.grantedRoots.includes(abs)) state.grantedRoots.push(abs);
    },

    touch() {
      state.mutationCount += 1;
    },

    startTurn() {
      state.questionsAsked = 0;
      // A plan held back last turn speaks only for that turn: the person's next message decides what happens.
      state.planHeld = false;
      state.turnStartChanges = state.changeSeq ?? 0;
    },

    reset() {

      for (const record of state.subprocesses.values()) {
        // Ended by the reset, not on its own: the new conversation is not told about it.
        record.stopRequested = true;
        try {
          killProcessTree(record.process);
        } catch {
        }
      }
      // Also untrack from global manager so exit handler doesn't double-kill
      for (const record of state.subprocesses.values()) {
        try { processManager.untrackExternal(record.process); } catch {}
      }
      state.changes = [];
      state.changeSeq = 0;
      state.turnStartChanges = 0;
      state.verifiedAt = undefined;
      state.executions = [];
      state.questionsAsked = 0;
      state.mutationCount = 0;
      state._projectCache = null;
      state._projectCacheKey = null;
      state.scope = [];
      state.activeProject = null;
      state.workedProject = null;
      state.subprocesses = new Map();
      state.background.clear();
      state.readFiles = new Set();
      state.seenText = new Map();
      state.todos = [];
      state.planPath = null;
    },
  };


  Object.defineProperty(state, 'sessionId', {
    enumerable: true,
    configurable: false,
    get: () => sessionId,
    set(next: string) {
      if (next === sessionId) return;
      throw new Error(
        `session identity is fixed for this conversation: refused to replace ${sessionId} with ${next}. ` +
          'A new conversation goes through replaceSession(); nothing below the CLI should need one.'
      );
    },
  });
  SESSION_UNLOCK.set(state, (next: string) => {
    sessionId = next;
  });

  return state;
}


/**
 * The recorded changes as they stand now, to compare with later. Every change is recorded as a new entry (a file
 * changed again moves to the end), so comparing entries, not counts, sees re-edits and survives the oldest dropping.
 */
export function changeMark(state: { changes?: FsChange[] } | null | undefined): ReadonlySet<FsChange> {
  return new Set(state?.changes ?? []);
}

/** The paths changed since `mark` was taken, each once, in the order last changed. */
export function changedSince(state: { changes?: FsChange[] } | null | undefined, mark: ReadonlySet<FsChange>): string[] {
  return [...new Set((state?.changes ?? []).filter((c) => !mark.has(c)).map((c) => String(c.path)))];
}

export function replaceSession(state: WorkspaceState, id: string, reason: string): void {
  if (!id) throw new Error('replaceSession requires a session id');
  const unlock = SESSION_UNLOCK.get(state);
  if (!unlock) throw new Error('replaceSession called on a state this module did not create');
  const previous = state.sessionId;
  if (previous === id) return;
  unlock(id);
  state.taskId = '';

  logger.debug(`session replaced: ${previous} -> ${id} (${reason})`);
}

/** `exits: false` leaves out the ended background processes, for a caller that tells the model about them on their own. */
/** The recorded changes no passing build, test, lint or type-check has come after (optionally: only this turn's). */
export function uncheckedChanges(state: Pick<WorkspaceState, 'changes' | 'verifiedAt' | 'turnStartChanges'>, { thisTurn = false } = {}): FsChange[] {
  const after = Math.max(Number(state.verifiedAt ?? 0), thisTurn ? Number(state.turnStartChanges ?? 0) : 0);
  return (state.changes ?? []).filter((c) => Number(c.seq ?? 0) > after);
}

/** Work happened in this project folder (absolute): it becomes the working project, unless it is the workspace root. */
export function noteWorkIn(state: Pick<WorkspaceState, 'root' | 'workedProject'> | null | undefined, project: string | null): void {
  if (!state?.root || !project) return;
  const abs = path.resolve(project);
  const root = path.resolve(state.root);
  if (!isInside(root, abs) || isInside(abs, root)) return;
  state.workedProject = { root: abs, name: path.basename(abs) };
}

/**
 * The folder commands and git run in when given none: the project this request names, else the one this conversation
 * last changed files in, but only when the workspace root is not a project itself (then the root is the place).
 */
export function workingProject(state: Pick<WorkspaceState, 'root' | 'activeProject' | 'workedProject'> | null | undefined): string | null {
  if (!state?.root) return null;
  // Where the work is beats a match on the request's words: the index scores every request, and a loose word match
  // must not move commands away from the project just built. A project deleted since is no place to run.
  const project = [state.workedProject?.root, state.activeProject?.root].find((p) => p && existsSync(p)) ?? null;
  if (!project || isInside(project, state.root)) return null;
  return holdsProjectMarker(state.root) ? null : project;
}

export function describeSession(state: WorkspaceState, { exits = true }: { exits?: boolean } = {}): string {
  const hasChanges = state.changes.length > 0;
  // Calls made for an earlier request are that request's; listed here they read as this one's work.
  const recent = state.executions.filter((e) => e.taskId === state.taskId).slice(-LEDGER_PROMPT_LINES);

  const running = [...state.subprocesses.values()].filter((s) => !s.exited && !s.error);
  const ended = exits ? describeExitsForModel(state.background?.pending() ?? []) : [];
  // The task list as the model last wrote it for this task: the tool result that set it scrolls away, the list does not.
  const todos = taskTodos(state);
  if (!hasChanges && recent.length === 0 && running.length === 0 && ended.length === 0 && todos.length === 0) return '';

  const lines = ['SESSION RECORD (kept by the system, not by you)', ...ended];
  // What changed since the last passing build/test/lint/type-check, as a fact the model can act on.
  if (Number(state.changeSeq ?? 0) > 0) {
    const since = uncheckedChanges(state);
    const files = [...new Set(since.map((c) => `${c.path}${c.op === 'delete' ? ' (deleted)' : ''}`))];
    lines.push(files.length
      ? `Changed since the last passing build or test: ${files.slice(-8).join(', ')}${files.length > 8 ? ` and ${files.length - 8} more` : ''} (not checked yet).`
      : 'Every change so far was followed by a passing build or test.');
  }
  const working = workingProject(state);
  if (working) {
    lines.push(`Working project: ${path.relative(state.root, working).split(path.sep).join('/')}/ — "this project" means it, and git and commands given no cwd run there.`);
  }

  if (todos.length > 0) {
    const mark = { pending: '[ ]', in_progress: '[~]', completed: '[x]' } as const;
    lines.push('Your task list, as you last wrote it (todo_write with the full list replaces it):');
    for (const t of todos) lines.push(`${mark[t.status] ?? '[ ]'} ${t.content}`);
  }

  if (running.length > 0) {
    lines.push('Background subprocesses still running (check one with subprocess_status, end it with stop_subprocess — do not start another for the same job):');
    for (const s of running) {
      const pid = (s.process as { pid?: number } | undefined)?.pid;
      lines.push(`- ${s.id}: ${s.command}${pid !== undefined ? ` (pid ${pid})` : ''}`);
    }
  }

  if (recent.length > 0) {
    lines.push('Tool calls actually executed for this request:');
    for (const e of recent) {
      const status = e.ok ? 'ok' : `FAILED${e.code ? ` [${e.code}]` : ''}`;
      const implication = !e.ok && e.code ? failureImplication(classifyFailure(e.code)) : '';
      const detail = e.detail ? ` — ${e.detail}` : '';
      const suffix = implication ? ` (${implication})` : '';
      lines.push(`- ${e.summary} → ${status}${suffix}${detail}`);
    }
  }

  if (hasChanges) {
    lines.push('Files and directories verified on disk:');
    for (const c of state.changes) {
      lines.push(`- ${c.op} ${c.type === 'dir' ? `${c.path}/` : c.path}`);
    }
  }

  lines.push(
    'This is the complete record of what ran for this request. Anything not listed here did not happen in it — ' +
      'do not claim otherwise, and do not write tool output yourself.'
  );
  return lines.join('\n');
}

export async function describeProject(state: WorkspaceState): Promise<string> {
  const cacheKey = `${state.root}:${state.mutationCount}`;
  if (state._projectCacheKey === cacheKey && state._projectCache) return state._projectCache;

  const lines: any[] = [];
  let truncated = false;

  const walk = async (dir: string, prefix: string, depth: number) => {
    if (depth > SNAPSHOT_DEPTH || truncated) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      if (lines.length >= SNAPSHOT_MAX_ENTRIES) {
        truncated = true;
        return;
      }
      if (entry.isDirectory()) {
        const skip = SNAPSHOT_SKIP.has(entry.name);
        lines.push(`${prefix}${entry.name}/${skip ? '  (contents omitted)' : ''}`);
        if (!skip) await walk(path.join(dir, entry.name), `${prefix}  `, depth + 1);
      } else {
        lines.push(`${prefix}${entry.name}`);
      }
    }
  };

  await walk(state.root, '', 1);

  let result;
  const header = 'CURRENT PROJECT (workspace root, read from disk just now)';
  if (lines.length === 0) result = `${header}\n(empty)`;
  else result = `${header}\n` + lines.join('\n') + (truncated ? '\n… (listing truncated)' : '');
  state._projectCacheKey = cacheKey;
  state._projectCache = result;
  return result;
}

