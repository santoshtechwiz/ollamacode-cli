import { AGENT_STATE } from '../../protocol';
import { logger } from '../../core/logger';
import { transition } from '../state';

type TurnResult = import('../../protocol.ts').TurnResult;

export function stopResult(content: string, stopReason: unknown): TurnResult {
  return {
    content,
    toolResults: [],
    iterations: 0,
    stopReason: stopReason as TurnResult['stopReason'],
  };
}

/** Route every transition-to-IDLE through here so failures are logged, not swallowed. */
export function transitionToIdle(box: any): void {
  if (box.state === AGENT_STATE.IDLE) return;
  try {
    transition(box, AGENT_STATE.IDLE);
  } catch (err) {
    logger.debug(`transition to IDLE failed: ${(err as Error).message}`);
    box.state = AGENT_STATE.IDLE;
  }
}

/** Wipe box + workspace plan state. Callers decide whether to transition afterwards. */
export function clearPlanState(box: any, workspace: any): void {
  box.resumable = false;
  box.plan = null;
  if (box.permissions) {
    box.permissions.plan_approved = false;
    box.permissions.action_approved = false;
  }
  if (workspace.state) {
    // buildSeedPlan reads workspace.state.plan ahead of box.plan, so leaving it set here
    // hands an unrelated later turn the previous plan's unfinished steps to "complete".
    workspace.state.plan = null;
    workspace.state.planPath = null;
  }
}
