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
    summary: 'reads the project to answer a question; changes nothing',
    readOnly: true,
    instruction: `${REPORT} Your task is research: read what you need and answer the question with file paths and line numbers. Change nothing.`,
    maxIterations: 12,
    timeoutMs: 180_000,
  },
  review: {
    id: 'review',
    summary: 'reviews code or a change for bugs and risks; changes nothing',
    readOnly: true,
    instruction: `${REPORT} Your task is review: read the code in question and report concrete problems, each with its file and line, most serious first. Change nothing.`,
    maxIterations: 12,
    timeoutMs: 180_000,
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

/**
 * Tools a child never gets. delegate_task: a child cannot start children, so depth stays at one. todo_write and
 * present_plan write the parent's task list and plan, which the child shares state with. ask_user: the person is the
 * parent's to ask; a child reports what it could not settle instead.
 */
export const CHILD_EXCLUDED_TOOLS: readonly string[] = Object.freeze(['delegate_task', 'todo_write', 'present_plan', 'ask_user']);

/** Children one parent turn may start; past it the delegate tool refuses and says why. */
export const MAX_DELEGATIONS_PER_TURN = 3;
