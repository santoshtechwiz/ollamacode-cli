import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../../tool/core/defineTool';
import { ok, fail } from '../../tool/core/tool-result';

export default defineTool({
  name: 'present_plan',
  profiles: ['planning'],
  category: 'agent',
  activity: 'Preparing a plan',
  label: 'Plan',
  description:
    'Show the user your plan and wait for their approval before changing anything. Call it in plan mode once you have ' +
    'looked at what you need. Write the plan as plain text with these ' +
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
          'Every file the plan will create, change or delete, workspace-relative. This is the scope of the plan: once it is approved, ' +
          'writing a file not listed here asks the user again.',
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
    return ok({
      kind: 'status',
      display: 'Plan ready for your approval.',
      data: { plan },
    });
  },
});
