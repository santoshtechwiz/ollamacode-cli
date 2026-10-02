import { ToolExecutor as RuntimeExecutor } from '../core/tool-runtime';
import type { ToolResult } from '../../types';
import type { ApproveFn } from '../policy/permission-policy';

/** What the turn loop needs from a tool runtime: run a call, get its result. */
export interface ToolExecutor {
  run(
    name: string,
    args: Record<string, unknown>,
    opts?: { signal?: AbortSignal; approve?: ApproveFn },
  ): Promise<{ result: ToolResult; timedOut: boolean; durationMs: number }>;
}

export interface ExecutorOptions {
  root: string;
  workspace?: any;
  state?: any;
  timeoutMs?: number;
  approve?: ApproveFn;
  ask?: any;
  onCommandOutput?: any;
}

/**
 * Tool execution only. Approval, path and scope gating all live in the runtime's
 * single choke point, so a call is never judged twice.
 */
export function createExecutor(opts: ExecutorOptions): ToolExecutor {
  return new RuntimeExecutor({
    root: opts.root,
    workspace: opts.workspace,
    state: opts.state,
    timeoutMs: opts.timeoutMs,
    approve: opts.approve,
    ask: opts.ask,
    onCommandOutput: opts.onCommandOutput,
  });
}
