import { FINISH_REASON } from '../../protocol';
import { readLines, guardTruncation } from './stream-reader';
import { formatRate, formatWireTiming, optionalMs } from './http';
import { ToolCallAccumulator } from './tool-call-accumulator';
import { traceStreamEvent } from '../stream-events';
import type { AgentEvent } from '../stream-events';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';

import type { StreamChatResult } from '../../types';

interface OllamaStreamState {
  full: string;
  reasoning: string;
  acc: ToolCallAccumulator;
  /** Next slot for a call the wire did not index; Ollama sends them complete. */
  toolSlot: number;
  sawDone: boolean;
  finishReason: StreamChatResult['finishReason'];
  doneReason?: string;
  usage: NonNullable<StreamChatResult['usage']>;
  metrics: NonNullable<StreamChatResult['metrics']>;
}

/** Ollama adapter: one NDJSON line -> AgentEvent[]. Only place that knows the wire names. Null = unparseable line. */
function parseOllamaLine(line: string, label: string): AgentEvent[] | null {
  if (!line.trim()) return [];
  let evt;
  try {
    evt = JSON.parse(line);
  } catch {
    logger.debug(`${label}: skipping unparseable line`, line.slice(0, 120));
    return null;
  }
  if (evt.error) {
    throw new ProviderError(`${label} error: ${evt.error}`, { retryable: false });
  }
  const events: AgentEvent[] = [];
  const msg = evt.message ?? {};
  if (typeof msg.thinking === 'string' && msg.thinking) {
    events.push({ type: 'reasoning', delta: msg.thinking });
  }
  if (typeof msg.content === 'string' && msg.content) {
    events.push({ type: 'assistant', delta: msg.content });
  }
  if (Array.isArray(msg.tool_calls)) {
    msg.tool_calls.forEach((tc: { index?: number; id?: string; function?: { name?: string; arguments?: unknown; }; }) => {
      const args = tc?.function?.arguments;
      events.push({
        type: 'tool_call_delta',
        // Only what the wire actually said.
        index: tc?.index,
        id: tc?.id,
        name: tc?.function?.name,
        argsText: typeof args === 'string' ? args : '',
        argsObj: args && typeof args === 'object' ? (args as Record<string, unknown>) : undefined,
      });
    });
  }
  if (evt.done) {
    events.push({
      type: 'finish',
      reason: evt.done_reason === 'length' ? FINISH_REASON.LENGTH : FINISH_REASON.STOP,
      doneReason: evt.done_reason,
    });
    events.push({
      type: 'usage',
      promptTokens: Number(evt.prompt_eval_count) || undefined,
      completionTokens: Number(evt.eval_count) || undefined,
      promptMs: optionalMs(evt.prompt_eval_duration),
      genMs: optionalMs(evt.eval_duration),
      loadMs: optionalMs(evt.load_duration),
    });
  }
  return events;
}

/** Parse one Ollama-NDJSON event line and advance the stream state. */
function handleEvent(
  line: string,
  state: OllamaStreamState,
  label: string,
  onDelta?: (chunk: string, full: string) => void,
  onReasoning?: (chunk: string, full: string) => void,
): boolean {
  const events = parseOllamaLine(line, label);
  if (events === null) return false;
  let done = false;
  for (const event of events) {
    traceStreamEvent(label, event);
    switch (event.type) {
      case 'reasoning':
        state.reasoning += event.delta;
        onReasoning?.(event.delta, state.reasoning);
        break;
      case 'assistant':
        state.full += event.delta;
        onDelta?.(event.delta, state.full);
        break;
      case 'tool_call_delta':
        state.acc.push(
          {
            index: event.index ?? state.toolSlot++,
            id: event.id,
            function: {
              name: event.name,
              arguments: event.argsObj !== undefined ? event.argsObj : event.argsText,
            },
          },
          event.index ?? state.toolSlot
        );
        break;
      case 'usage': {
        state.usage = {
          promptTokens: event.promptTokens,
          completionTokens: event.completionTokens,
        };
        state.metrics = {
          promptMs: event.promptMs,
          genMs: event.genMs,
          loadMs: event.loadMs,
          promptTokensPerSec: event.promptMs
            ? Number(event.promptTokens ?? 0) / (event.promptMs / 1000)
            : undefined,
          genTokensPerSec: event.genMs
            ? Number(event.completionTokens ?? 0) / (event.genMs / 1000)
            : undefined,
        };
        break;
      }
      case 'finish':
        state.sawDone = true;
        state.doneReason = event.doneReason;
        if (event.reason === FINISH_REASON.LENGTH) state.finishReason = FINISH_REASON.LENGTH;
        done = true;
        break;
      default:
        break;
    }
  }
  return done;
}

/** Log the standard Ollama timing line after a done event. */
function logTiming(
  label: string,
  model: string,
  state: OllamaStreamState,
  extra: string,
) {
  logger.debug(
    `${label} ${model}: ${formatWireTiming({
      promptTokens: state.usage.promptTokens,
      genTokens: state.usage.completionTokens,
      promptMs: state.metrics.promptMs,
      genMs: state.metrics.genMs,
      loadMs: state.metrics.loadMs,
    })} (${formatRate(state.metrics.promptTokensPerSec)} / ${formatRate(state.metrics.genTokensPerSec)})` +
    ` · reasoning=${state.reasoning.length}ch answer=${state.full.length}ch` +
    `${extra}`
  );
}

interface OllamaStreamResult {
  content: string;
  toolCalls: import('../../types.ts').ToolCall[];
  reasoning: string;
  finishReason: StreamChatResult['finishReason'];
  usage: NonNullable<StreamChatResult['usage']>;
  metrics: NonNullable<StreamChatResult['metrics']>;
}

/** Shared NDJSON stream loop for both local Ollama and Ollama Cloud. */
export async function consumeOllamaStream(
  label: string,
  model: string,
  res: Response,
  signal: AbortSignal | undefined,
  opts: {
    onDelta?: (chunk: string, full: string) => void;
    onReasoning?: (chunk: string, full: string) => void;
    logExtra?: (state: OllamaStreamState) => string;
  } = {},
): Promise<OllamaStreamResult> {
  const state: OllamaStreamState = {
    full: '',
    reasoning: '',
    acc: new ToolCallAccumulator(),
    toolSlot: 0,
    sawDone: false,
    finishReason: FINISH_REASON.STOP,
    usage: {},
    metrics: {},
  };

  const cancelled = await guardTruncation(label, async () => {
    for await (const line of readLines(res, { signal })) {
      const done = handleEvent(line, state, label, opts.onDelta, opts.onReasoning);
      if (done) {
        logTiming(label, model, state, opts.logExtra?.(state) ?? '');
        break;
      }
    }
  }, () => state.sawDone);

  if (cancelled) {
    return {
      content: state.full,
      toolCalls: state.acc.finish(),
      reasoning: state.reasoning,
      finishReason: FINISH_REASON.ABORTED,
      usage: state.usage,
      metrics: state.metrics,
    };
  }

  const toolCalls = state.acc.finish();
  return {
    content: state.full,
    toolCalls,
    reasoning: state.reasoning,
    finishReason:
      state.finishReason === FINISH_REASON.LENGTH
        ? FINISH_REASON.LENGTH
        : toolCalls.length
          ? FINISH_REASON.TOOL_CALLS
          : state.finishReason,
    usage: state.usage,
    metrics: state.metrics,
  };
}
