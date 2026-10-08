import type { FinishReason } from '../protocol';
import { logger } from '../core/logger';

/** Common internal stream model. Adapters emit it; gateway/loop/renderer only see this. `reasoning` never becomes assistant text. */
export type AgentEvent =
  | { type: 'reasoning'; delta: string; }
  | { type: 'assistant'; delta: string; }
  | { type: 'tool_call_delta'; index?: number; id?: string; name?: string; argsText: string; argsObj?: Record<string, unknown>; }
  | { type: 'usage'; promptTokens?: number; completionTokens?: number; promptMs?: number; genMs?: number; loadMs?: number; }
  | { type: 'finish'; reason: FinishReason; doneReason?: string; }
  | { type: 'error'; error: Error; };

const STREAM_EVENT = Object.freeze({
  REASONING: 'reasoning',
  ASSISTANT: 'assistant',
  TOOL_CALL_DELTA: 'tool_call_delta',
  USAGE: 'usage',
  FINISH: 'finish',
  ERROR: 'error',
} as const);

/** Pipeline trace: chunk -> event -> renderer. Lengths only unless OCODE_STREAM_DEBUG_TEXT=1. */
export function traceStreamEvent(label: string, event: AgentEvent): void {
  // File-only (trace): per-chunk lengths would flood stderr on every delta.
  const chunks = process.env.OCODE_STREAM_DEBUG === '1';
  if (!logger.enabled('trace') && !chunks) return;
  // One line per streamed chunk is thousands per reply; the reply's usage and finish say what came back.
  const chunk = event.type === STREAM_EVENT.REASONING || event.type === STREAM_EVENT.ASSISTANT || event.type === STREAM_EVENT.TOOL_CALL_DELTA;
  if (chunk && !chunks) return;
  const verbose = process.env.OCODE_STREAM_DEBUG_TEXT === '1';
  let summary: string;
  switch (event.type) {
    case STREAM_EVENT.REASONING:
    case STREAM_EVENT.ASSISTANT:
      summary = `${event.type} +${event.delta.length}ch`;
      break;
    case STREAM_EVENT.TOOL_CALL_DELTA:
      summary = `tool_call_delta idx=${event.index} +${event.argsText.length}ch`;
      break;
    case STREAM_EVENT.USAGE:
      summary = `usage prompt=${event.promptTokens ?? '?'} completion=${event.completionTokens ?? '?'}`;
      break;
    case STREAM_EVENT.FINISH:
      summary = `finish ${event.reason}${event.doneReason ? ` (${event.doneReason})` : ''}`;
      break;
    case STREAM_EVENT.ERROR:
      summary = `error ${event.error.message.slice(0, 120)}`;
      break;
    default:
      summary = 'unknown';
  }
  logger.trace(`[stream:${label}] ${summary}`, { component: 'stream', stream: label });
  if (verbose) {
    logger.traceBlock(`stream:${label} ${event.type}`, JSON.stringify(event).slice(0, 2000), { component: 'stream', stream: label });
  }
}
