import { createPermissions } from '../tool/policy/permission-policy';

/** What a session carries from turn to turn: its permissions and the request it is on. */
export interface AgentStateBox {
  permissions: import('../tool/policy/permission-policy.ts').PermissionState;
  task?: string | null;
  /** Identity for `task`. */
  taskId?: string | null;
}

export function createAgentState(): AgentStateBox {
  return { permissions: createPermissions(), task: null, taskId: null };
}

export function resetSessionState(box: AgentStateBox): AgentStateBox {
  box.task = null;
  box.taskId = null;
  return box;
}
