import fs from 'node:fs/promises';
import path from 'node:path';

import { killProcessTree, processManager } from '../env/process/index';
import { classifyFailure, EPHEMERAL_SESSION } from '../protocol';
import { failureImplication } from '../prompts/recovery';
import { logger } from '../core/logger';
import { normalizeRelPath } from '../core/paths';
import { BackgroundInbox, describeExitsForModel } from '../tool/process/background-inbox';

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
  '.agent',
]);

const SNAPSHOT_MAX_ENTRIES = 60;

const SNAPSHOT_DEPTH = 2;

const MAX_EXECUTIONS = 40;

const LEDGER_PROMPT_LINES = 12;

export interface FsChange {
  op: string;
  path: string;
  type: 'file' | 'dir';
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
  index: import('./workspace-index/_shared.ts').IndexHandle | null;
  tooling?: import('../env/tooling/manager.ts').ToolingManager | null;
  questionsAsked: number;
  autoFixAuthorized: boolean;
  mutationCount: number;
  subprocesses: Map<string, import('../tool/process/subprocess-state.ts').SubprocessRecord>;
  /** Background processes that ended on their own, until a turn has shown them to the model. */
  background: BackgroundInbox;
  readFiles: Set<string>;
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
  /** Each plan-mode exploration this session, kept for the saved session record only. */
  planExplorations?: import('../types.ts').Message[][];
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
    todos: [],
    planPath: null,

    note(op, rel, type) {
      const existing = state.changes.findIndex((c) => normalizeRelPath(c.path) === normalizeRelPath(rel) && c.type === type);
      if (existing !== -1) state.changes.splice(existing, 1);
      state.changes.push({ op, path: rel, type });
      if (state.changes.length > MAX_CHANGES) state.changes.shift();
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
      state.executions = [];
      state.questionsAsked = 0;
      state.mutationCount = 0;
      state._projectCache = null;
      state._projectCacheKey = null;
      state.scope = [];
      state.activeProject = null;
      state.subprocesses = new Map();
      state.background.clear();
      state.readFiles = new Set();
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

export function describeSession(state: WorkspaceState): string {
  const hasChanges = state.changes.length > 0;
  // Calls made for an earlier request are that request's; listed here they read as this one's work.
  const recent = state.executions.filter((e) => e.taskId === state.taskId).slice(-LEDGER_PROMPT_LINES);

  const running = [...state.subprocesses.values()].filter((s) => !s.exited && !s.error);
  const ended = describeExitsForModel(state.background?.pending() ?? []);
  if (!hasChanges && recent.length === 0 && running.length === 0 && ended.length === 0) return '';

  const lines = ['SESSION RECORD (kept by the system, not by you)', ...ended];

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

