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
  at: number;
  /**
   * The workspace's mutation count when it settled: file changes and every command or script that may have changed
   * something. A later identical call at the same count would see the same world.
   */
  world?: number;
  /** For a read-only call, the modification time of each path it was given, so an edit nothing recorded still shows. */
  stamps?: Record<string, number>;
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
  const calls = state.toolCalls;
  const last = calls.at(-1);
  if (!last) return 0;
  let streak = 0;
  for (let i = calls.length - 1; i >= 0 && signatureOf(calls[i]) === signatureOf(last); i--) streak++;
  return streak;
}

/**
 * How many times this call already ran in the turn with nothing changed since: its earlier runs settled at the mutation
 * count the workspace is still at. Run that often, it would only say the same again.
 */
export function unchangedRepeats(state: TurnState, signature: string, world: number): number {
  return state.toolCalls.filter((c) => c.world === world && signatureOf(c) === signature).length;
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
