import type { Message, ToolSchema, ToolCall } from '../types';



/** The read side of the conversation store a request is assembled against. */
export interface ContextStore {
  readonly messages: Message[];
  /** History target from config; unset, the builder sizes it from the window. */
  readonly budgetTokens?: number;
  /** Messages that survive any compaction by contract (plan, requirements). */
  readonly pinnedIndices: Set<number>;
  /** Ids of mid-turn scaffolding, never persisted and never ranked last. */
  readonly ephemeralIds: Set<string>;
  /** Summary carried across processes for a resumed, windowed record. */
  readonly preservedSummary: string | null;
  readonly tokenCount: number;
  /** Written by the builder after each assembly, read by `/context`. */
  lastBudget: (ContextBudget & { promptBudget: number; levels: string[]; dropped: number; }) | null;
  addUser(content: string, options?: { pinned?: boolean; ephemeral?: boolean; slot?: string; }): void;
  /** Takes back the note a slot holds, once it has served its purpose. */
  removeSlot(slot: string): void;
  addAssistant(content: string, toolCalls?: ToolCall[]): void;
  addToolResult(call: ToolCall, content: string): void;
}

/** The final accounting of one assembled request. */
export interface ContextBudget {
  /** Window the prompt is driven at (window - output reserve). */
  contextLimit: number;
  outputReserve: number;
  systemTokens: number;
  toolSchemaTokens: number;
  /** The current request message alone — historyTokens excludes it once. */
  requestTokens: number;
  /** Kept history, minus the request message. */
  historyTokens: number;
  /** Trailing workspace snapshot + summary, priced separately. */
  trailingTokens: number;
  /** Total input tokens actually assembled (`inputTokens`). */
  inputTokens: number;
  totalReserved: number;
  utilization: number;
  /** Tokens over the usable window (0 when the assembled request fits). */
  overflow: number;
}

/** An immutable, assembled request snapshot. */
export interface PreparedContext {
  messages: readonly Message[];
  tools: readonly ToolSchema[];
  budget: ContextBudget;
  /** Messages evicted in the last compact pass. */
  dropped: number;
}