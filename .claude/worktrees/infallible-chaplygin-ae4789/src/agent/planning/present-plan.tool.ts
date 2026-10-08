import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../../tool/core/defineTool';
import { ok, fail } from '../../tool/core/tool-result';

export default defineTool({
  name: 'present_plan',
  profiles: ['planning', 'core', 'always'],
  category: 'agent',
  activity: 'Preparing a plan',
  label: 'Plan',
  description:
    'Show the user your plan and wait for their approval before changing anything. Call it in plan mode once you have ' +
    'looked at what you need, and in agent mode whenever the user asks for a plan: there it shows the plan, asks the user ' +
    'whether to start, and returns their answer. Write the plan as plain text with these ' +
    'section headers: "Goal" (one sentence), "Implementation" (numbered steps, each naming the file it changes, e.g. ' +
    '"1. Add shipping() to Cart; File: src/cart.js"), and "Validation" (the command that checks the change, e.g. ' +
    '"1. Run: npm test"). List every file the plan changes in files as well. If nothing needs to change, the whole plan is NOTHING_TO_CHANGE followed by why; ' +
    'when the request only asks a question, that is NOTHING_TO_CHANGE followed by the full answer. After calling ' +
    'it, stop and wait: the user approves, asks for changes, or rejects it.',
  parameters: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The plan text, with Goal, Implementation and Validation sections.' },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description:
          'The plan as a checklist: one short line per step, in order (e.g. "Create the Web API project", "Run: dotnet build"). ' +
          'This is the list the user watches tick off while the plan runs.',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Every file the plan will create, change or delete, workspace-relative. In plan mode this is the scope of the plan: once it ' +
          'is approved, writing a file not listed here asks the user again.',
      },
    },
    required: ['plan'],
  },

  preview(args) {
    return `plan: ${String(args?.plan ?? '').split('\n').find((line) => line.trim()) ?? ''}`.slice(0, 120);
  },

  async execute(args, ctx) {
    const plan = String(args.plan ?? '').trim();
    if (!plan) return fail('plan must not be empty', { code: TOOL_ERROR_CODE.EINVAL });
    // The turn that asked for a plan reads it from here once this turn ends, and puts it to the user for approval.
    if (ctx.state) {
      ctx.state.presentedPlan = plan;
      ctx.state.presentedPlanFiles = Array.isArray(args.files) ? args.files.map(String).filter((f: string) => f.trim() !== '') : null;
      ctx.state.presentedPlanSteps = Array.isArray(args.steps) ? args.steps.map(String).filter((s: string) => s.trim() !== '') : null;
    }
    // Plan mode's own loop puts the plan to the person once its exploration ends.
    if (ctx.state?.planExploring) {
      return ok({ kind: 'status', display: 'Plan ready for your approval.', data: { plan } });
    }
    // Nobody to ask, but the person approved everything up front (--yes): the plan is approved, so it is carried out.
    if (!ctx.state?.reviewOnly && typeof ctx.ask !== 'function' && ctx.state?.autoFixAuthorized) {
      if (ctx.state) {
        ctx.state.presentedPlan = null;
        ctx.state.planHeld = false;
      }
      return {
        ...ok({ kind: 'status', display: 'Plan approved up front (--yes) — carrying it out.', data: { plan, approved: true } }),
        modelNote: 'The user approved everything up front for this run. Carry the plan out now, step by step, with the tools; do not present it again.',
      };
    }
    // A turn that cannot change files (Ask, Review), or one with nobody to answer (a piped run), has no start to offer:
    // the plan is the answer, and nothing waits on an approval that cannot come.
    if (ctx.state?.reviewOnly || typeof ctx.ask !== 'function') {
      if (ctx.state) {
        ctx.state.presentedPlan = null;
        // Not started: nothing changes for the rest of this turn.
        ctx.state.planHeld = true;
      }
      return {
        ...ok({ kind: 'status', display: 'Plan written — not started.', data: { plan, approved: false } }),
        modelNote: ctx.state?.reviewOnly
          ? 'This mode cannot change files, so the plan is not started. Give the plan as your answer; the user can switch to Agent mode to carry it out.'
          : 'Nobody can approve a plan in this session, so it is not started. Give the plan as your answer and change nothing.',
      };
    }
    // Agent mode has no loop to read it: the person sees it and answers here, so whether to start never rests on the
    // model remembering to ask.
    const START = 'Yes, start now';
    const WAIT = 'Not yet';
    let answer = '';
    try {
      answer = String(await ctx.ask(`${plan}\n\nStart this plan now?`, [START, WAIT]) ?? '').trim();
    } catch {
      answer = '';
    }
    if (answer === START) {
      if (ctx.state) {
        ctx.state.presentedPlan = null;
        ctx.state.planHeld = false;
      }
      return {
        ...ok({ kind: 'status', display: 'Plan approved — carrying it out.', data: { plan, approved: true } }),
        modelNote: 'The user approved this plan. Carry it out now, step by step, with the tools; do not present it again.',
      };
    }
    if (ctx.state) {
      ctx.state.presentedPlan = null;
      ctx.state.planHeld = true;
    }
    const said = answer && answer !== WAIT ? ` They said: ${answer}` : '';
    return {
      ...ok({
        kind: 'status',
        display: answer && answer !== WAIT ? `Plan not started — ${answer}` : 'Plan not started.',
        data: { plan, approved: false, ...(said ? { feedback: answer } : {}) },
      }),
      modelNote: `The user did not start this plan.${said} Change nothing; answer briefly${said ? ' and revise the plan if they asked for changes' : ''}, then wait.`,
    };
  },
});
