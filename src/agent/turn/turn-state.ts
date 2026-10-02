import type { StopReason } from '../../protocol';
import { callSignature } from '../router/memo';

export interface ToolCallRecord {
  /** Provider call id; one id may only receive one tool result in a turn. */
  callId?: string;
  name: string;
  args: Record<string, unknown>;
  result: import('../../types.ts').ToolResult;
  isRepeat: boolean;
  /** Exactly what the model was shown for this call; rendered once when recorded. */
  rendered?: string;
  /** Refused only to load its schema: bookkeeping, not an attempt, so the repeat guard lets the next call through. */
  schemaPending?: boolean;
  at: number;
  /** The file this call was about, and how that file looked when it ran. */
  target?: string | null;
  targetStamp?: string | null;
  /** How the file looked once the call had run. An identical later request whose target still
   *  looks like this has already had its effect, whatever else has moved since. */
  afterStamp?: string | null;
  /** Mutations recorded when it ran; a lower count now means the workspace has moved since. */
  world?: number;
  /** The tool's own key for what this result found, when it defines one. */
  resultKey?: string;
  /** It ran, but its key matched an earlier call's: a reworded repeat that found nothing new, so not progress. */
  foundNothingNew?: boolean;
  /** callSignature(name, args), worked out once: the guards compare it against every later call. */
  signature?: string;
}

/** A record's call signature, computed the first time it is asked for. */
export function signatureOf(call: ToolCallRecord): string {
  return (call.signature ??= callSignature(call.name, call.args));
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