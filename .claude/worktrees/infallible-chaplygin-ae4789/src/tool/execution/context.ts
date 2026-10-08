import type { AskOptions } from '../../types';
import type { Workspace } from '../../agent/workspace/manager';
import type { WorkspaceState } from '../../context/workspace-state';
import type { TypedLogger } from '../../core/logger';
import type { Plan } from '../../agent/planning/plan';
import type { PermissionState } from '../policy/permission-policy';
import type { AgentStateBox } from '../../agent/state';
import type { InvalidCallMemo } from '../../agent/router/memo';

export interface ToolContext {
  ws: Workspace;
  cwd: string;
  root?: string;
  state?: WorkspaceState;
  signal?: AbortSignal;
  log?: TypedLogger;
  ask?: (question: string, options?: string[], opts?: AskOptions) => Promise<string>;
  plan?: Plan | null;
  permissions?: PermissionState;
  agentState?: AgentStateBox;
  onCommandOutput?: (text: string) => void;
  memo?: InvalidCallMemo;
  /** This call's approval, its clocks stopped while the person answers; a subagent's calls ask through it. */
  approve?: import('../policy/permission-policy.ts').ApproveFn;
  /** Starts a subagent; set only in a turn that may (see agent/subagent). */
  delegate?: import('../../agent/subagent/runner.ts').DelegateFn;
}

export type ToolContextInput = Omit<ToolContext, 'ws'> & { ws?: ToolContext['ws']; };