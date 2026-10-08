import { defineTool } from '../../tool/core/defineTool';
import { ok } from '../../tool/core/tool-result';
import { PLAN_MODE } from '../../prompts/planning';

/**
 * Agent mode's way into plan mode, as Claude Code's EnterPlanMode: the same state as the person choosing /plan, so a
 * plan asked for in Agent mode is made the way plan mode makes it. The mode's instructions are this call's result.
 */
export default defineTool({
  name: 'enter_plan_mode',
  profiles: ['core'],
  category: 'agent',
  readOnly: true,
  activity: 'Switching to plan mode',
  label: 'Plan mode',
  description:
    'Switch to plan mode before planning: call it when the user asks for a plan, or how you would build something, ' +
    'rather than for the work itself. In plan mode you look around with read-only tools, then present the plan with ' +
    'present_plan; nothing changes until the user approves it, and then you carry it out in the same turn.',
  parameters: { type: 'object', properties: {} },

  async execute(_args, ctx) {
    const state = ctx.state as any;
    if (state?.reviewOnly) {
      return ok({ kind: 'status', display: 'This mode cannot change files: answer with the plan instead.' });
    }
    if (state?.planExploring) {
      return { ...ok({ kind: 'status', display: 'Already in plan mode.' }), modelNote: PLAN_MODE.trim() };
    }
    if (state) {
      state.planExploring = true;
      state.planHeld = false;
    }
    return { ...ok({ kind: 'status', display: 'Plan mode — looking around before proposing a plan.' }), modelNote: PLAN_MODE.trim() };
  },
});
