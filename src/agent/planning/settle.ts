import { AGENT_STATE, STOP_REASONS, INCOMPLETE_STOP_REASONS } from '../../protocol';
import { deletePlan, getActivePlan, getPlanPath, savePlanProgress } from './store';
import path from 'node:path';
import { planChecklist } from './plan';
import { unfinishedTodos } from './todo-write.tool';
import { transition } from '../state';
import { TOOL_META } from '../../tool/index';

const INCOMPLETE = new Set(INCOMPLETE_STOP_REASONS);

/** A list written this turn and taken all the way to done, in a turn the harness did not cut short. */
function listDeclaredDone(result: any, todos: unknown): boolean {
  if (!result || INCOMPLETE.has(result.stopReason as any)) return false;

  const wroteList = (result.toolResults ?? []).some(
    (tr: any) => TOOL_META[String(tr?.name ?? '')]?.tracksTasks === true && tr?.result?.ok,
  );

  return wroteList && Array.isArray(todos) && todos.length > 0 && unfinishedTodos(todos).length === 0;
}

export function settlePlan({ box, workspace, result }: any): void {
  if (box.state !== AGENT_STATE.EXECUTING && box.state !== AGENT_STATE.COMPLETED) return;

  if (box.state === AGENT_STATE.EXECUTING) {
    transition(box, AGENT_STATE.COMPLETED);
    transition(box, AGENT_STATE.IDLE);
  }

  const plan = box.plan;
  if (!plan) {
    syncState();
    return;
  }

  const stalled = Boolean(result) && INCOMPLETE.has(result?.stopReason as any);
  // Only changes made after approval are evidence for this plan's steps.
  const changes = (workspace.state?.changes ?? []).slice(Number(box.planChangesFrom ?? 0));
  const checklist = planChecklist(plan, changes, { finished: Boolean(result) && !stalled });
  // A list the model took all the way to done is its own record of finishing, and outranks the plan's guesses.
  const items = listDeclaredDone(result, workspace.state?.todos) ? checklist.map((item) => ({ ...item, status: 'done' as const })) : checklist;
  const pending = items.filter((item) => item.status !== 'done').length;
  // Every step checked off. A plan with nothing to check has not been shown done, so it never counts as finished on its own.
  const allDone = items.length > 0 && pending === 0;

  // A turn that ended on its own ends the plan: what is done is done, what is not is said. Only a turn
  // cut short (stuck, step limit, cut-off output, cancelled) leaves it open, and only for /continue in this session.
  const cancelled = result?.stopReason === STOP_REASONS.CANCELLED;
  const ends = allDone || (Boolean(result) && !stalled && !cancelled);

  if (result) {
    // Nothing countable means nothing to report: an empty list is noise, not progress.
    if (items.length > 0) {
      result.planChecklist = items;
      result.planRemaining = pending;
    }
    if (allDone) result.stopReason = STOP_REASONS.COMPLETE;
  }

  // Only a plan's own steps have stable indices to save; a plan without steps is re-derived from its files each time.
  plan.doneSteps = (plan.steps ?? []).length ? items.flatMap((item, index) => (item.status === 'done' ? [index] : [])) : [];
  let planPath: string | null = null;
  try {
    planPath = getActivePlan(workspace.cwd) ? getPlanPath(workspace.cwd) : null;
    if (planPath && !ends) savePlanProgress(planPath, { doneSteps: plan.doneSteps, ran: plan.ran });
  } catch { }

  if (ends) {
    if (result && items.length > 0) result.planSummary = summarize({ ...plan, changesFrom: box.planChangesFrom ?? 0 }, items, workspace);
    box.plan = null;
    box.resumable = false;
    clearApproval();
    // Finished is finished: nothing about this plan is left on disk to come back later.
    try {
      if (planPath) deletePlan(planPath);
    } catch { }
  } else {
    box.resumable = true;
  }

  if (workspace.state) workspace.state.planPath = box.plan ? getPlanPath(workspace.cwd) : null;

  syncState();

  function clearApproval() {
    if (box.permissions) {
      box.permissions.plan_approved = false;
      box.permissions.action_approved = false;
    }
  }

  function syncState() {
    if (workspace.state) {
      workspace.state.plan = box.plan;
      workspace.state.permissions = box.permissions;
      workspace.state.agentState = box;
    }
  }
}

/** What the plan did, for the one summary the person sees when it ends. */
function summarize(plan: any, items: Array<{ title: string; status: string }>, workspace: any): import('../../protocol.ts').PlanSummary {
  const cwd = String(workspace?.cwd ?? '');
  const files: string[] = [];
  // Only what changed after the plan was approved is the plan's work.
  for (const change of (workspace?.state?.changes ?? []).slice(Number(plan?.changesFrom ?? 0))) {
    const raw = String(change?.path ?? '');
    if (!raw) continue;
    const rel = (path.isAbsolute(raw) && cwd ? path.relative(cwd, raw) : raw).replace(/\\/g, '/');
    if (rel && !files.includes(rel)) files.push(rel);
  }
  return {
    title: String(plan?.summary ?? plan?.goal ?? 'plan').replace(/\s+/g, ' ').trim(),
    done: items.filter((item) => item.status === 'done').length,
    total: items.length,
    notDone: items.filter((item) => item.status !== 'done').map((item) => item.title),
    files,
    ran: [...(plan?.ran ?? [])],
  };
}
