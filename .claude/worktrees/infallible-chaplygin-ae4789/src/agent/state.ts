import { AGENT_STATE, canTransition } from '../protocol';

import { createPermissions } from '../tool/policy/permission-policy';

export interface AgentStateBox {
  state: import('../protocol.ts').AgentStateName;
  plan: import('./planning/plan.ts').Plan | null;
  resumable: boolean;
  permissions: import('../tool/policy/permission-policy.ts').PermissionState;
  task?: string | null;
  /** Identity for `task`. */
  taskId?: string | null;
  /** This session has said it does not want the workspace's active plan. */
  planDetached?: boolean;
  /** How many workspace changes there were when the plan was approved; the plan's own start after that. */
  planChangesFrom?: number;
}

export function createAgentState(): AgentStateBox {
  return {
    state: AGENT_STATE.IDLE,
    plan: null,
    resumable: false,
    permissions: createPermissions(),
    task: null,
    taskId: null,
    planDetached: false,
  };
}

export function transition(box: AgentStateBox, next: import('../protocol.ts').AgentStateName): AgentStateBox {
  if (!canTransition(box.state, next)) {
    throw new Error(`invalid agent state transition: ${box.state} -> ${next}`);
  }
  box.state = next;
  return box;
}

export function resetSessionState(box: AgentStateBox): AgentStateBox {
  const fresh = createAgentState();
  fresh.permissions = box.permissions;
  box.state = fresh.state;
  box.plan = fresh.plan;
  box.resumable = fresh.resumable;
  box.task = fresh.task;
  box.taskId = fresh.taskId;
  box.planDetached = fresh.planDetached;
  return box;
}

