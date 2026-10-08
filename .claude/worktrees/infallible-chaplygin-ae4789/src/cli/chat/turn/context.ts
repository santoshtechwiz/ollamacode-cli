import type { Renderer } from '../../../ui/render/index';
import type { TypedFlags } from '../../flags';
import type { ToolResult } from '../../../types';

export type TurnResult = Awaited<ReturnType<import('../../../agent/runtime.ts').AgentRuntime['execute']>>;

export interface ChatTurnContext {
  flags: TypedFlags;
  cfg: any;
  interactive: boolean;
  session: { provider: any; model: string };
  workspace: any;
  history: any;
  agentState: any;
  runtime: any;
  render: Renderer;
  toolsEnabled: boolean;
  onPromptOwnership?: (owned: boolean) => void;
}

export interface TurnOptions {
  signal: AbortSignal;
  planMode: boolean;
  noPlan?: boolean;
  reviewMode?: boolean;
  askMode?: boolean;
  resumePlan?: boolean;
  /** The person chose to continue unfinished work. */
  continuing?: boolean;
  onModeSwitch?: (next: string) => void;
  onToolResult?: (name: string, args: Record<string, unknown>, result: ToolResult, origin?: string) => void;
  onStepComplete?: (entry: { name: string; args: Record<string, unknown>; result: ToolResult }) => void;
  /** The turn knows which task it is (new, or the one being continued): task-scoped state can be shown now. */
  onTaskStart?: () => void;
}

