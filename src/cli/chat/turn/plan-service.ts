import { PLAN_DECISION } from '../../../protocol';
import { renderPlan } from '../../../agent/planning/plan';
import { confirmPlan } from '../../../ui/prompts';
import { holdingTerminal } from './holding-terminal';
import type { ChatTurnContext } from './context';

export type OnPlanFn = (plan: import('../../../agent/planning/plan.ts').Plan) => Promise<{
  decision: typeof PLAN_DECISION[keyof typeof PLAN_DECISION];
  feedback?: string;
  unavailable?: boolean;
}>;

export function createOnPlanFn(host: ChatTurnContext, signal: AbortSignal): OnPlanFn {
  const { render, workspace, interactive, flags } = host;
  return async (plan: import('../../../agent/planning/plan.ts').Plan) => {
    // The model's own plan, shown once; the parsed steps are bookkeeping, not something to read twice.
    render.plan(plan.presented?.trim() ? plan.presented : renderPlan(plan));
    if (workspace.state?.autoFixAuthorized) {
      return { decision: PLAN_DECISION.APPROVE };
    }
    if (!interactive) {
      render.note(
        flags.plan
          ? '--plan with no terminal to approve on — nothing was run'
          : 'this request needs an approved plan, and there is no terminal to approve on — nothing was run. Run interactively to approve, or pass --yes.',
        'warn'
      );
      return { decision: PLAN_DECISION.REJECT, unavailable: true };
    }
    const { decision, feedback, unavailable } = await holdingTerminal(host, () => confirmPlan(signal));
    if (decision === PLAN_DECISION.REGENERATE) render.note(feedback ? `revising with: ${feedback}` : 'regenerating…', 'dim');
    else if (decision === PLAN_DECISION.REJECT) render.note(unavailable ? 'no way to ask — nothing was changed' : 'rejected — nothing was changed', 'warn');
    return { decision, feedback, unavailable };
  };
}
