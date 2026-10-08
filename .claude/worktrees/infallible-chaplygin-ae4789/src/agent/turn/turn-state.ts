import type { StopReason } from '../../protocol';
import { callSignature } from '../router/memo';

export interface ToolCallRecord {
  /** Provider call id; one id may only receive one tool result in a turn. */
  callId?: string;
  name: string;
  args: Record<string, unknown>;
  result: import('../../types.ts').ToolResult;
  /** Exactly what the model was shown for this call; rendered once when recorded. */
  rendered?: string;
  /** Refused only to load its schema: the handshake, not an attempt, so it never counts toward a repeat. */
  schemaPending?: boolean;
  at: number;
  /** callSignature(name, args), worked out once. */
  signature?: string;
}

/** A record's call signature, computed the first time it is asked for. */
export function signatureOf(call: ToolCallRecord): string {
  return (call.signature ??= callSignature(call.name, call.args));
}

/** The same call this many times in a row, nothing else between, is a loop: the one safety stop besides the step limit. */
export const SAME_CALL_LIMIT = 3;

/** How many times the latest call was made in a row, counting back until a different call. */
export function sameCallStreak(state: TurnState): number {
  const calls = state.toolCalls.filter((c) => !c.schemaPending);
  const last = calls.at(-1);
  if (!last) return 0;
  let streak = 0;
  for (let i = calls.length - 1; i >= 0 && signatureOf(calls[i]) === signatureOf(last); i--) streak++;
  return streak;
}

export interface TurnState {
  iteration: number;
  maxIterations: number;
  toolCalls: ToolCallRecord[];
  answer: string | undefined;
  stopReason: StopReason | undefined;
}

export function createTurnState(maxIterations: number = 25): TurnState {
  return {
    iteration: 0,
    maxIterations,
    toolCalls: [],
    answer: undefined,
    stopReason: undefined,
  };
}
