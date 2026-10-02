import { AGENT_STATE, PLAN_DECISION, ROLE, STOP_REASONS } from '../../protocol';
import { transition } from '../state';
import { createPlanner, planningContextFor, planModeInstruction, toLegacyPlan, PlannerError } from './planner';
import { ContextStore } from '../../context/store';
import { selectToolDefs } from '../../context/tool-surface';
import { runTurn } from '../turn/turn';
import type { PlanningReason } from './plan-types';
import { buildRegenerationNote } from './plan';
import { createPlan, markPlanChanged, markPlanRejected, getPlanPath, planFileExists } from './store';
import { stopResult, transitionToIdle } from '../turn/helpers';
import type { Profile } from '../turn/context';

type TurnResult = import('../../protocol.ts').TurnResult;
type Message = import('../../types.ts').Message;

interface PlanLoopArgs {
  box: any;
  workspace: any;
  provider: any;
  model: any;
  system: Message[];
  task: string;
  config: any;
  profile: Profile;
  signal?: AbortSignal;
  onPlan: NonNullable<any>;
  replanFrom: import('../turn/context.ts').ReplanTrigger | null;
  /** The conversation so far; plan mode explores on a copy of it. */
  history: ContextStore;
  gateway?: any;
  toolRunner?: any;
  callbacks?: Record<string, any>;
}

interface PlanLoopOutcome {
  kind: 'proceed' | 'stop';
  /** A plan was shown and approved; false when the planner judged none was needed. */
  approved?: boolean;
  /** The plan as it was shown, when the turn ended before anyone could approve it. */
  shown?: any;
  /** The model's own reply when the request needed no plan (a question it answered): it belongs in the conversation. */
  answer?: string;
  result?: TurnResult;
}

/**
 * Turn-owned bound on approval revisions in a single turn. This lives here —
 * not inside the planner — so the planner stays a single bounded call.
 */
const MAX_PLAN_REVISIONS = 3;

function resetPlanState(box: any): void {
  box.plan = null;
  if (box.permissions) box.permissions.plan_approved = false;
  transitionToIdle(box);
}

/** Plan mode is a turn like any other, limited to the read-only tools: the model looks at what it needs, then presents its plan. */
async function presentedPlan(args: PlanLoopArgs, instruction: string): Promise<{ text: string; files: string[] | null; steps: string[] | null; cancelled: boolean }> {
  const { workspace, history, profile } = args;
  if (workspace.state) {
    workspace.state.presentedPlan = null;
    workspace.state.presentedPlanFiles = null;
    workspace.state.presentedPlanSteps = null;
  }
  const exploring = new ContextStore({
    messages: [...history.messages, { role: ROLE.USER, content: args.task }],
    budgetTokens: history.budgetTokens,
  });
  const turn = await runTurn({
    provider: args.provider,
    model: args.model,
    history: exploring,
    systemMessages: [...args.system, { role: ROLE.SYSTEM, content: instruction }],
    toolsEnabled: true,
    toolProfile: {
      compact: profile.compact,
      core: profile.core,
      native: workspace.nativeTools !== false,
      readOnly: true,
      always: selectToolDefs({ core: profile.core, readOnly: true }).map((def) => def.name),
    },
    config: args.config,
    cwd: workspace.cwd,
    state: workspace.state,
    signal: args.signal,
    gateway: args.gateway,
    toolRunner: args.toolRunner,
    // The plan is shown once, in the approval view; streaming it as it is written would show it twice.
    callbacks: { ...(args.callbacks ?? {}), onDelta: undefined },
  });
  // The plan is what the model presented: through present_plan, or as the answer it ended the turn with.
  // The exploration ran in its own store; the session record keeps a copy so its calls can be diagnosed later.
  if (workspace.state) {
    const explored = exploring.messages.slice(history.messages.length);
    workspace.state.planExplorations = [...(workspace.state.planExplorations ?? []), explored];
  }
  const text = String(workspace.state?.presentedPlan || turn.content || '');
  const files = workspace.state?.presentedPlan ? workspace.state.presentedPlanFiles ?? null : null;
  const steps = workspace.state?.presentedPlan ? workspace.state.presentedPlanSteps ?? null : null;
  if (workspace.state) {
    workspace.state.presentedPlan = null;
    workspace.state.presentedPlanFiles = null;
    workspace.state.presentedPlanSteps = null;
  }
  return { text, files, steps, cancelled: turn.stopReason === STOP_REASONS.CANCELLED };
}

export async function runPlanApprovalLoop(args: PlanLoopArgs): Promise<PlanLoopOutcome> {
  const {
    box, workspace, task, onPlan, replanFrom,
  } = args;

  box.resumable = false;
  if (box.permissions) {
    box.permissions.plan_approved = false;
    box.permissions.action_approved = false;
    box.permissions.denied = false;
    box.permissions.deniedTool = null;
  }
  transitionToIdle(box);
  transition(box, AGENT_STATE.PLANNING);

  const planner = createPlanner({ cwd: workspace.cwd });

  const stacks = (workspace.state as { stacks?: { test?: string[] }[] } | undefined)?.stacks;
  let feedback: string | undefined;
  let revisions = 0;
  for (;;) {
    const reason: PlanningReason =
      revisions > 0 ? 'NEW_INFORMATION' : replanFrom ? 'VERIFICATION_FAILED' : 'INITIAL';
    let outcome: Awaited<ReturnType<typeof planner.fromPresented>>;
    try {
      const context = planningContextFor(task, reason, {
        ...(feedback ? { feedback } : {}),
        ...(stacks ? { stacks } : {}),
      });
      const presented = await presentedPlan(args, planModeInstruction(context, workspace.cwd));
      // A cancelled exploration presented nothing because the person stopped it, not because the model had no plan.
      if (presented.cancelled) {
        resetPlanState(box);
        return { kind: 'stop', result: stopResult('', STOP_REASONS.CANCELLED) };
      }
      outcome = await planner.fromPresented(context, presented.text, presented.files, presented.steps);
    } catch (err) {
      // Malformed or empty planner output is distinguishable from a decline:
      // nothing was approved and nothing ran.
      if (err instanceof PlannerError) {
        resetPlanState(box);
        return {
          kind: 'stop',
          result: stopResult(
            'The model produced no plan to approve, so nothing was run. Try again, or drop plan mode for this request.',
            STOP_REASONS.PLAN_UNAVAILABLE,
          ),
        };
      }
      resetPlanState(box);
      throw err;
    }

    if (outcome.kind === 'CLARIFICATION') {
      resetPlanState(box);
      return {
        kind: 'stop',
        result: stopResult(outcome.reason, STOP_REASONS.COMPLETE),
      };
    }

    if (outcome.kind === 'NO_PLAN') {
      // The model judged the request needs no multi-step plan. Preserve the
      // existing domain semantics: "nothing to change" ends the turn with a
      // summary, anything smaller just proceeds to execution.
      if (outcome.reason.startsWith('NOTHING_TO_CHANGE:')) {
        const summary = outcome.reason.slice('NOTHING_TO_CHANGE:'.length).trim();
        resetPlanState(box);
        return {
          kind: 'stop',
          ...(summary ? { answer: summary } : {}),
          result: stopResult(summary || 'Reviewed the code — nothing needs to change.', STOP_REASONS.COMPLETE),
        };
      }
      resetPlanState(box);
      return { kind: 'proceed', approved: false };
    }

    const plan = toLegacyPlan(outcome.plan);

    box.plan = plan;
    transition(box, AGENT_STATE.WAITING_FOR_APPROVAL);

    let decision: any;
    let approvalFeedback: any;
    let unavailable = false;
    try {
      ({ decision, feedback: approvalFeedback, unavailable = false } = await onPlan(plan));
    } catch (err) {
      resetPlanState(box);
      throw err;
    }

    if (decision === PLAN_DECISION.APPROVE) {
      if (box.permissions) {
        box.permissions.plan_approved = true;
        box.permissions.action_approved = false;
      }
      transition(box, AGENT_STATE.EXECUTING);
      try {
        const created = createPlan({
          plan: box.plan,
          task,
          workspaceRoot: workspace.cwd,
          sessionId: workspace.state?.sessionId,
        });
        if (workspace.state) workspace.state.planPath = created.planPath;
        if (replanFrom) markPlanChanged(replanFrom.planPath);
      } catch { /* plan record is state/UX-only; never block execution */ }
      return { kind: 'proceed', approved: true };
    }

    if (decision === PLAN_DECISION.REGENERATE) {
      revisions += 1;
      if (revisions > MAX_PLAN_REVISIONS) {
        resetPlanState(box);
        return {
          kind: 'stop',
          result: stopResult('Plan cancelled — nothing was changed.', STOP_REASONS.PLAN_DECLINED),
        };
      }
      transition(box, AGENT_STATE.PLANNING);
      const planPath = getPlanPath(workspace.cwd);
      try {
        if (planFileExists(planPath)) markPlanChanged(planPath);
      } catch { /* ignore */ }
      feedback = buildRegenerationNote(approvalFeedback);
      continue;
    }

    // Rejected or prompt-unavailable.
    const shown = plan;
    box.plan = null;
    if (box.permissions) {
      box.permissions.plan_approved = false;
      if (!unavailable) box.permissions.denied = true;
    }
    const planPath = getPlanPath(workspace.cwd);
    try {
      if (planFileExists(planPath)) markPlanRejected(planPath);
    } catch { /* ignore */ }
    transitionToIdle(box);
    return {
      kind: 'stop',
      shown,
      result: stopResult(
        unavailable
           ? 'A plan was ready but there was no way to ask you to approve it — nothing was changed and nothing was declined.'
           : 'Plan cancelled — nothing was changed.',
        unavailable ? STOP_REASONS.PROMPT_UNAVAILABLE : STOP_REASONS.PLAN_DECLINED
      ),
    };
  }
}
