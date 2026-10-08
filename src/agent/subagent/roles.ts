import { agentConfig } from '../../core/config';

// What each kind of subagent may do. A role is data: one more entry here is a new kind of subagent.
//
// A child is a turn like any other, run on its own conversation; the role decides its tools, its step budget and its
// time limit. Time limits stay under the tool runtime's own 10 minutes, so a child that runs out of time comes back
// with what it got done rather than being cut off by the runtime.

export interface SubagentRole {
  id: string;
  /** One line, for the delegate tool's description. */
  summary: string;
  /** Only the read-only (planning) tools: it can look, never change anything. */
  readOnly: boolean;
  /** Tools on top of that set, for a role whose looking reaches further than the project (the web). */
  also?: readonly string[];
  /** The child's own instruction, after the system prompt it shares with the parent. */
  instruction: string;
  maxIterations: number;
  timeoutMs: number;
}

const REPORT =
  'You are a subagent: another agent gave you this task and will continue with your answer. You cannot ask anyone ' +
  'anything; if something is unclear or out of reach, say so in your answer. End with a short report: what you found ' +
  'or did, which files you changed (if any), and anything left undone.';

export const SUBAGENT_ROLES: Readonly<Record<string, SubagentRole>> = Object.freeze({
  research: {
    id: 'research',
    summary: 'looks things up in the project or on the web to answer a question; changes nothing',
    readOnly: true,
    // The web tools read; they change nothing in the project, so research keeps them.
    also: ['web_search', 'web_fetch'],
    instruction: `${REPORT} Your task is research: find what you need, in the project or on the web, and answer with where it came from (file and line, or the page). Change nothing.`,
    maxIterations: 20,
    timeoutMs: 300_000,
  },
  review: {
    id: 'review',
    summary: 'reviews code or a change for bugs and risks; changes nothing',
    readOnly: true,
    instruction: `${REPORT} Your task is review: read the code in question and report concrete problems, each with its file and line, most serious first. Change nothing.`,
    maxIterations: 20,
    timeoutMs: 300_000,
  },
  coding: {
    id: 'coding',
    summary: 'makes a focused code change and checks it',
    readOnly: false,
    instruction: `${REPORT} Your task is a code change: make exactly the change asked for, keep it minimal, and check it (build or run the tests) before you report.`,
    maxIterations: 25,
    timeoutMs: 480_000,
  },
  test: {
    id: 'test',
    summary: 'runs or writes tests and reports the results',
    readOnly: false,
    // An instruction, not an enforced rule: nothing stops this role from editing a source file.
    instruction: `${REPORT} Your task is testing: run the tests asked for, or write them, and report what passed and what failed with the error. Change only test files.`,
    maxIterations: 15,
    timeoutMs: 480_000,
  },
});

/** What a person may set for a role of their own in agent.subagentRoles; only the instruction is required. */
export interface CustomRoleConfig {
  summary?: string;
  instruction: string;
  readOnly?: boolean;
  also?: string[];
  maxIterations?: number;
  timeoutMs?: number;
}

/** A custom role's time limit stays under the tool runtime's 10 minutes, like the built-in ones. */
const MAX_CUSTOM_TIMEOUT_MS = 480_000;

/**
 * The built-in roles plus the person's own from agent.subagentRoles. A custom role is read-only unless it says
 * otherwise, gets the same reporting rule as every role, and may take a built-in's name to replace it.
 */
export function allRoles(custom: Record<string, CustomRoleConfig> | undefined = agentConfig().subagentRoles): Readonly<Record<string, SubagentRole>> {
  const roles: Record<string, SubagentRole> = { ...SUBAGENT_ROLES };
  for (const [id, cfg] of Object.entries(custom ?? {})) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(id) || typeof cfg?.instruction !== 'string' || !cfg.instruction.trim()) continue;
    roles[id] = {
      id,
      summary: String(cfg.summary ?? `${id} (your own role)`),
      readOnly: cfg.readOnly !== false,
      also: Array.isArray(cfg.also) ? cfg.also.map(String) : undefined,
      instruction: `${REPORT} ${cfg.instruction.trim()}`,
      maxIterations: Number(cfg.maxIterations) > 0 ? Math.floor(Number(cfg.maxIterations)) : 15,
      timeoutMs: Math.min(MAX_CUSTOM_TIMEOUT_MS, Number(cfg.timeoutMs) > 0 ? Math.floor(Number(cfg.timeoutMs)) : 300_000),
    };
  }
  return Object.freeze(roles);
}

/**
 * Tools a child never gets. delegate_task: a child cannot start children, so depth stays at one. todo_write and
 * present_plan write the parent's task list and plan, which the child shares state with. ask_user: the person is the
 * parent's to ask; a child reports what it could not settle instead.
 */
export const CHILD_EXCLUDED_TOOLS: readonly string[] = Object.freeze(['delegate_task', 'todo_write', 'present_plan', 'ask_user']);

/** Children one parent turn may start; past it the delegate tool refuses and says why. */
export const MAX_DELEGATIONS_PER_TURN = 3;
