import fs from 'node:fs';
import path from 'node:path';

import { TOOL_ERROR_CODE } from '../../protocol';
import { isInside } from '../../tool/core/paths';
import { noteWorkIn } from '../../context/workspace-state';
import { defineTool } from '../../tool/core/defineTool';
import { ok, fail } from '../../tool/core/tool-result';
import { todoLines, type TodoItem } from '../todos';

const START = 'Yes, start now';
const CHANGE = 'Change something';
const WAIT = 'Not yet';

/** The folder as the person reads it: the workspace root said in words, any other folder with a trailing slash. */
function where(folder: string): string {
  return folder === '.' ? 'the workspace root' : `\`${folder.replace(/[\\/]+$/, '')}/\``;
}

/** A step as approved: what will work, and the command that proves it when one does. */
interface Step {
  outcome: string;
  verify?: string;
}

/** A step as sent: an outcome with its check, or the plain text older calls send. */
function stepOf(raw: unknown): Step | null {
  const outcome = String((raw && typeof raw === 'object' ? (raw as any).outcome : raw) ?? '').trim();
  if (!outcome) return null;
  const verify = raw && typeof raw === 'object' ? String((raw as any).verify ?? '').trim() : '';
  return verify ? { outcome, verify } : { outcome };
}

/** What the person approves: where the work goes, the plan, and its steps, which become the task list once they say yes. */
function shown(plan: string, steps: Step[], folder: string): string {
  const head = folder ? `**Where:** ${where(folder)}\n\n` : '';
  const line = (step: Step, i: number) => `${i + 1}. ${step.outcome}${step.verify ? ` — checked by \`${step.verify}\`` : ''}`;
  return `${head}${plan}${steps.length ? `\n\n**Steps**\n${steps.map(line).join('\n')}` : ''}`;
}

/** The approved folder becomes where the work is: made if new, and where commands given no folder run. */
function settleFolder(state: any, root: string | undefined, folder: string): void {
  if (!state || !root || !folder || folder === '.') return;
  const abs = path.resolve(root, folder);
  if (!isInside(path.resolve(root), abs)) return;
  try { fs.mkdirSync(abs, { recursive: true }); } catch { return; }
  noteWorkIn(state, abs);
}

/** Approved: plan mode is over, the plan's steps are the task list, and the same turn carries the plan out. */
function approved(state: any, plan: string, steps: Step[], display: string) {
  const todos: TodoItem[] = steps.map((step) => ({ content: step.outcome, status: 'pending', ...(step.verify ? { verify: step.verify } : {}) }));
  if (state) {
    state.planExploring = false;
    state.planHeld = false;
    if (todos.length) state.todos = todos;
  }
  const list = todos.length
    ? `\nIts steps are your task list now:\n${todoLines(todos).join('\n')}\nAs you work, change them with todo_write update: mark the one you start in_progress; a task with verify is completed when that command passes, one without it when you send evidence of what showed it works; split, add, reorder or remove tasks when what you find changes the plan.`
    : '';
  return {
    ...ok({ kind: 'status', display, data: { plan, approved: true } }),
    modelNote: `The user approved this plan. Carry it out now with the tools.${list}`,
  };
}

/** Not approved: nothing changes for the rest of this turn. */
function held(state: any, plan: string, display: string, modelNote: string) {
  if (state) state.planHeld = true;
  return { ...ok({ kind: 'status', display, data: { plan, approved: false } }), modelNote };
}

export default defineTool({
  name: 'present_plan',
  profiles: ['planning', 'core'],
  category: 'agent',
  activity: 'Preparing a plan',
  label: 'Plan',
  description:
    'Show the user your plan and ask whether to start. Call it in plan mode (enter_plan_mode gets you there from agent ' +
    'mode) once you have looked at what you need. Write the plan under the headings the plan field names, and list ' +
    'its steps in steps. The result is their answer: approved (carry it out now), changes to make (revise and present ' +
    'again), or not now (change nothing).',
  parameters: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'The plan in markdown, written so the user can trust it before anything runs. Use these headings, scaled to ' +
          'the task (a one-file fix needs a few lines under each; a new service needs them in full): ' +
          '## Goal (what will exist or work when done); ' +
          '## Current state (what you found in the project, or that it is new); ' +
          '## Approach (the design and why it fits; any alternative you rejected and why); ' +
          '## Changes (each file to create or change, and what goes in it); ' +
          '## Decisions and assumptions (libraries, versions, defaults you chose, which the user may want to change); ' +
          '## Risks (what could go wrong, and how you will handle it); ' +
          '## Verification (the commands that prove it works, and what they should show). ' +
          'Never a one-line summary: the user approves from this text.',
      },
      folder: {
        type: 'string',
        pathArg: true,
        description:
          'Where the work goes, workspace-relative: the folder the user named; for a new project with none named, a new ' +
          'folder of its own (for example "e-hailing-service"), never the workspace root or another project\'s folder ' +
          'unless the user asked. "." means the workspace root. The user sees it and can change it before approving.',
      },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            outcome: { type: 'string', description: 'What will work when this step is done ("The API serves GET /todos"), not a step of typing ("Create server.js")' },
            verify: { type: 'string', description: 'A shell command whose exit 0 proves it ("npm test", "dotnet build"); leave it out when no command does' },
          },
          required: ['outcome'],
        },
        description: 'The plan as outcomes in order. Once approved they are the task list the user watches, and a step with verify is ticked when its command passes.',
      },
    },
    required: ['plan', 'folder'],
  },

  preview(args) {
    return `plan: ${String(args?.plan ?? '').split('\n').find((line) => line.trim()) ?? ''}`.slice(0, 120);
  },

  async execute(args, ctx) {
    const plan = String(args.plan ?? '').trim();
    if (!plan) return fail('plan must not be empty', { code: TOOL_ERROR_CODE.EINVAL });
    const state = ctx.state as any;
    const steps = (Array.isArray(args.steps) ? args.steps : []).map(stepOf).filter((step: Step | null): step is Step => step !== null);
    // Path arguments arrive resolved; the person reads the folder as the workspace names it.
    const root = ctx.root ?? ctx.cwd;
    const given = String(args.folder ?? '').trim();
    const folder = !given ? '.' : root && path.isAbsolute(given) ? path.relative(root, given).split(path.sep).join('/') || '.' : given;
    const canAsk = typeof ctx.ask === 'function';
    const start = (display: string) => {
      settleFolder(state, root, folder);
      return approved(state, plan, steps, display);
    };

    if (state?.reviewOnly) {
      return held(state, plan, 'Plan written — not started.', 'This mode cannot change files, so the plan is not started. Give the plan as your answer; the user can switch to Agent mode to carry it out.');
    }
    if (!canAsk) {
      if (state?.autoFixAuthorized) return start('Plan approved up front (--yes) — carrying it out.');
      return held(state, plan, 'Plan written — not started.', 'Nobody can approve a plan in this session, so it is not started. Give the plan as your answer and change nothing.');
    }

    let answer = '';
    try {
      answer = String((await ctx.ask!('Start this plan now?', [START, CHANGE, WAIT], { detail: shown(plan, steps, folder) })) ?? '').trim();
      // Their own words: what to change, folder included. An empty answer changes nothing.
      if (answer === CHANGE) answer = String((await ctx.ask!('What should change in the plan?')) ?? '').trim() || WAIT;
    } catch {
      answer = '';
    }
    if (answer === START) return start('Plan approved — carrying it out.');
    if (answer && answer !== WAIT) {
      return held(state, plan, `Plan not started — ${answer}`, `The user asked for changes: ${answer}\nRevise the plan and call present_plan again; change nothing until it is approved.`);
    }
    return held(state, plan, 'Plan not started.', 'The user did not start this plan. Change nothing; answer briefly, then wait.');
  },
});
