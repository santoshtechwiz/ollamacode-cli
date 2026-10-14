// The OpenAI chat-completions wire format, shared by the providers that speak it (HuggingFace's router, OpenRouter):
// the request body, the SSE stream of deltas, and the tool-call message shape. Each provider keeps its own address,
// key and error wording.
import { FINISH_REASON, ROLE, TOOL_CALL_TYPE } from '../../protocol';
import { readSse, guardTruncation } from './stream-reader';
import { getFetch, errorBody, traceWireBody } from './http';
import { ToolCallAccumulator } from './tool-call-accumulator';
import { traceStreamEvent } from '../stream-events';
import type { AgentEvent } from '../stream-events';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';
import type { Message, StreamChatResult } from '../../types';

/** One SSE delta -> AgentEvent[]. Only place that knows the wire names. */
export function parseOpenAIDelta(delta: {
  reasoning?: unknown;
  reasoning_content?: unknown;
  content?: unknown;
  tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: unknown; }; }[];
}): AgentEvent[] {
  const events: AgentEvent[] = [];
  const thought = (delta?.reasoning ?? delta?.reasoning_content) as unknown;
  if (typeof thought === 'string' && thought) {
    events.push({ type: 'reasoning', delta: thought });
  }
  if (typeof delta?.content === 'string' && delta.content) {
    events.push({ type: 'assistant', delta: delta.content });
  }
  if (Array.isArray(delta?.tool_calls)) {
    delta.tool_calls.forEach((tc, i) => {
      const args = tc?.function?.arguments;
      events.push({
        type: 'tool_call_delta',
        index: tc?.index ?? i,
        id: tc?.id,
        name: tc?.function?.name,
        argsText: typeof args === 'string' ? args : '',
        argsObj: args && typeof args === 'object' ? (args as Record<string, unknown>) : undefined,
      });
    });
  }
  return events;
}

export interface OpenAIChatRequest {
  /** The provider's name, in errors and traces. */
  label: string;
  /** The chat-completions URL. */
  url: string;
  headers: Record<string, string>;
  /** Throws the provider's own error for a failed response it recognises (bad key, no credits); returns otherwise. */
  rejectResponse?: (res: Response) => void;
  model: string;
  messages: Message[];
  tools?: unknown[];
  signal?: AbortSignal;
  onDelta?: (delta: string, full: string) => void;
  onReasoning?: (delta: string, full: string) => void;
  sampling?: { temperature?: number; maxTokens?: number };
  /** Fields this provider adds to the request body. */
  extraBody?: Record<string, unknown>;
}

export async function streamOpenAIChat(req: OpenAIChatRequest): Promise<StreamChatResult> {
  const { label, url, model, messages, tools, signal, onDelta, onReasoning, sampling = {} } = req;
  const body = {
    model,
    messages: normalizeOpenAI(messages),
    stream: true,
    ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
    ...(sampling.maxTokens ? { max_tokens: sampling.maxTokens } : {}),
    ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    ...(req.extraBody ?? {}),
  };
  traceWireBody(url, body);

  const res = await getFetch()(url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    req.rejectResponse?.(res);
    throw new ProviderError(`${label} error ${res.status}: ${await errorBody(res)}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }

  let full = '';
  let reasoning = '';
  const acc = new ToolCallAccumulator();
  let finished = false;
  let finishReason = (FINISH_REASON.STOP as StreamChatResult['finishReason']);
  let usage;

  const cancelled = await guardTruncation(label, async () => {
    for await (const evt of readSse(res, { signal })) {
      if (evt.data === '[DONE]') {
        finished = true;
        break;
      }

      let payload;
      try {
        payload = JSON.parse(evt.data);
      } catch {
        logger.debug(`${label}: skipping unparseable SSE data`, evt.data.slice(0, 120));
        continue;
      }

      if (payload.error) {
        throw new ProviderError(
          `${label} error: ${payload.error.message ?? payload.error}`,
          { retryable: false }
        );
      }

      if (payload.usage) {
        usage = {
          promptTokens: payload.usage.prompt_tokens,
          completionTokens: payload.usage.completion_tokens,
        };
      }

      const choice = payload.choices?.[0];
      if (!choice) continue;

      const delta = choice.delta ?? {};
      for (const event of parseOpenAIDelta(delta)) {
        traceStreamEvent(label, event);
        switch (event.type) {
          case 'reasoning':
            reasoning += event.delta;
            onReasoning?.(event.delta, reasoning);
            break;
          case 'assistant':
            full += event.delta;
            onDelta?.(event.delta, full);
            break;
          case 'tool_call_delta':
            acc.push(
              {
                index: event.index,
                id: event.id,
                function: {
                  name: event.name,
                  arguments: event.argsObj !== undefined ? event.argsObj : event.argsText,
                },
              },
              event.index
            );
            break;
          default:
            break;
        }
      }

      if (choice.finish_reason) {
        finishReason = choice.finish_reason === FINISH_REASON.LENGTH ? FINISH_REASON.LENGTH : finishReason;
        finished = true;
        // The usage chunk can follow the finish chunk: read on to [DONE] for it.
      }
    }
  }, () => finished);
  if (cancelled) {
    return { content: full, toolCalls: acc.finish(), reasoning, finishReason: FINISH_REASON.ABORTED, usage };
  }

  const toolCalls = acc.finish();
  return {
    content: full,
    toolCalls,
    reasoning,
    finishReason:
      finishReason === FINISH_REASON.LENGTH
        ? FINISH_REASON.LENGTH
        : toolCalls.length
          ? FINISH_REASON.TOOL_CALLS
          : finishReason,
    usage,
  };
}

export function normalizeOpenAI(messages: Message[]) {
  let seq = 0;
  const out: any[] = [];
  let pendingIds: any[] = [];

  for (const m of messages) {
    if (m.role === ROLE.ASSISTANT && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const toolCalls = m.tool_calls.map((tc) => {
        const id = tc.id || `call_${seq++}`;
        const args =
          typeof tc.function.arguments === 'string'
            ? tc.function.arguments
            : JSON.stringify(tc.function.arguments ?? {});
        return { id, type: TOOL_CALL_TYPE, function: { name: tc.function.name, arguments: args } };
      });
      pendingIds = toolCalls.map((t) => t.id);
      out.push({ role: ROLE.ASSISTANT, content: m.content || '', tool_calls: toolCalls });
      continue;
    }

    if (m.role === ROLE.TOOL) {
      const fallback = pendingIds.shift();
      out.push({
        role: ROLE.TOOL,
        content: String(m.content ?? ''),
        tool_call_id: m.tool_call_id || fallback || `call_orphan_${seq++}`,
      });
      continue;
    }

    pendingIds = [];
    out.push({ role: m.role, content: m.content ?? '', ...(m.name ? { name: m.name } : {}) });
  }
  return out;
}
