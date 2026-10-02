import { dim, yellow } from '../../../ui/ansi';
import { CmdResult } from './types';
import { setMode, withoutMode } from '../../chat/mode';

export async function runPlan(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const sub = String(arg ?? '').trim().toLowerCase();
  if (sub === 'replan') {
    const { getActivePlan, markPlanNeedsReplan, getPlanPath } = await import('../../../agent/planning/store.ts');
    const active = ctx.workspace?.cwd ? getActivePlan(ctx.workspace.cwd) : null;
    if (!active) {
      ctx.write(`${dim('  no active plan for this workspace')}\n`);
      return CmdResult.HANDLED;
    }
    if (active.status !== 'NEEDS_REPLAN') {
      markPlanNeedsReplan(getPlanPath(ctx.workspace.cwd), 'requested via /plan replan');
    }
    ctx.write(
      `${yellow('  plan flagged for replanning')}${dim(' — run /continue to propose a fresh plan for the unfinished work')}\n`
    );
    return CmdResult.HANDLED;
  }
  if (sub === 'close') {
    // Ends the plan here and now: nothing about it stays on disk, nothing comes back later.
    const { getActivePlan, getPlanPath, summarizeRecord, deletePlan } = await import('../../../agent/planning/store.ts');
    const cwd = ctx.workspace?.cwd;
    const active = cwd ? getActivePlan(cwd) : null;
    const box = ctx.agentState;
    if (!active && !box?.plan) {
      ctx.write(`${dim('  No plan is open.')}\n`);
      return CmdResult.HANDLED;
    }
    const s = active ? summarizeRecord(active) : null;
    if (active) deletePlan(getPlanPath(cwd));
    if (box) {
      box.plan = null;
      box.resumable = false;
      if (box.permissions) {
        box.permissions.plan_approved = false;
        box.permissions.action_approved = false;
      }
    }
    if (ctx.workspace?.state) {
      ctx.workspace.state.plan = null;
      ctx.workspace.state.planPath = null;
    }
    ctx.write(
      `  Closed "${s?.title ?? box?.plan?.summary ?? 'plan'}"${s ? dim(` — ${s.done} of ${s.total} steps were done`) : ''}\n`
    );
    return CmdResult.HANDLED;
  }
  if (sub === 'off') {
    setMode(ctx, withoutMode(ctx, 'plan'));
    ctx.persist();
    return CmdResult.HANDLED;
  }
  if (sub === 'on') {
    setMode(ctx, 'plan');
    ctx.persist();
    return CmdResult.HANDLED;
  }
  // Bare /plan explicitly enters Plan mode (not a toggle).
  setMode(ctx, 'plan');
  ctx.persist();
  return CmdResult.HANDLED;
}
