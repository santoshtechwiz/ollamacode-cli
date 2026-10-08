import { PLAN_STATUS, STOP_REASONS } from '../../protocol';
import { getActivePlan, getPlanPath, isPlanComplete, lastPlanFor } from './store';
import { stopResult } from '../turn/helpers';

type TurnResult = import('../../protocol.ts').TurnResult;

/** The person chose to continue, but the last plan already ended: say so instead of running it again. */
export function replyForFinishedPlan(args: { workspace: any; continuing: boolean; toolsEnabled: boolean; reviewOnly: boolean; needPlan: boolean; box: any }): TurnResult | null {
  const { workspace, continuing, toolsEnabled, reviewOnly, needPlan, box } = args;
  if (reviewOnly || !toolsEnabled || needPlan || box.resumable || !continuing) return null;
  const lastPlan = lastPlanFor(workspace.cwd);
  if (!lastPlan || isForeignPlan(workspace, lastPlan) || lastPlan.status === PLAN_STATUS.NEEDS_REPLAN || (lastPlan.status === PLAN_STATUS.ACTIVE && !isPlanComplete(lastPlan))) return null;
  const title = String(lastPlan.title ?? '').trim() || 'the last plan';
  const content = lastPlan.status === PLAN_STATUS.DONE
    ? `The plan "${title}" is complete — its work already landed, so I won't run anything new. Tell me what you'd like done next.`
    : lastPlan.status === PLAN_STATUS.FAILED
      ? `The plan "${title}" ended with a failed step — I won't keep re-running it. Ask me to adjust and try again.`
      : `The plan "${title}" is still open — tell me whether to carry on with it or what you'd like done next.`;
  return stopResult(content, STOP_REASONS.COMPLETE);
}

/** The person chose to continue: pick the workspace's unfinished plan back up from disk. */
export function hydrateResumeFromPlan(args: { workspace: any; box: any; continuing: boolean; reviewOnly: boolean; toolsEnabled: boolean }): void {
  const { workspace, box, continuing, reviewOnly, toolsEnabled } = args;
  if (reviewOnly || !toolsEnabled || box.resumable || box.planDetached || !continuing) return;
  const active = getActivePlan(workspace.cwd);
  // Only this session's own plan is picked back up; plans never carry across sessions.
  const ownSession = Boolean(active?.sessionId) && active?.sessionId === workspace.state?.sessionId;
  if (!active || !ownSession || isForeignPlan(workspace, active) || isPlanComplete(active)) return;
  box.plan = { summary: active.title ?? '', steps: active.steps ?? [], files: active.affectedFiles ?? { create: [], edit: [], del: [] }, runs: active.runs ?? [], raw: active.raw ?? '', doneSteps: active.doneSteps ?? [], ran: active.ran ?? [] };
  box.resumable = true;
  if (box.permissions) box.permissions.plan_approved = true;
  if (workspace.state) workspace.state.planPath = getPlanPath(workspace.cwd);
  const carried = String(active.title ?? '').trim() || String(active.task ?? '').trim();
  if (carried) box.task = carried;
}

function isForeignPlan(workspace: any, plan: { sessionId?: string }): boolean {
  return Boolean(plan?.sessionId && workspace?.state?.sessionId && plan.sessionId !== workspace.state.sessionId);
}
