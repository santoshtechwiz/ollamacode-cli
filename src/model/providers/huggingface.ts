import { PROVIDER_ERROR_CODE, FINISH_REASON, ROLE, TOOL_CALL_TYPE } from '../../protocol';
import { loadConfig, updateConfig } from '../../core/config';
import { readSse, guardTruncation } from './stream-reader';
import { fetchJson, getFetch, errorBody, getFetchGeneration, traceWireBody } from './http';
import { ToolCallAccumulator } from './tool-call-accumulator';
import { traceStreamEvent } from '../stream-events';
import type { AgentEvent } from '../stream-events';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';

const DEFAULT_BASE = 'https://router.huggingface.co/v1';
const WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';
const DETECT_TTL_MS = 60_000;

function baseUrl() {
  const raw = process.env.HF_BASE_URL || process.env.HF_ENDPOINT || DEFAULT_BASE;
  return raw.replace(/\/+$/, '');
}

function modelsUrl() {
  const limit = Number(process.env.HF_MODEL_LIMIT) || 40;
  return `https://huggingface.co/api/models?inference_provider=all&pipeline_tag=text-generation&sort=likes&limit=${limit}`;
}

function getToken(): string {
  const raw = process.env.HF_TOKEN || loadConfig().tokens?.huggingface || '';
  return String(raw).trim();
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

let detectCache: any = null;

async function fetchModels(token: string): Promise<{ name: string; }[]> {
  const res = await fetchJson(modelsUrl(), {
    headers: { Authorization: `Bearer ${token}` },
    timeoutMs: 10_000,
    label: 'huggingface model list',
  });
  assertAuthOk(res);
  if (!res.ok) {
    throw new ProviderError(`HuggingFace error ${res.status}: ${await errorBody(res)}`, {
      status: res.status,
    });
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new ProviderError('HuggingFace returned an unexpected model list payload');
  }
  return data.map((m) => ({ name: m.id })).filter((m) => m.name);
}

function assertAuthOk(res: Response) {
  if (res.status === 401) {
    throw new ProviderError('Invalid HuggingFace token. Create one at huggingface.co/settings/tokens', {
      status: 401,
    });
  }
  if (res.status === 403) {
    throw new ProviderError(
      'This token cannot call Inference Providers. Enable "Make calls to Inference Providers" at huggingface.co/settings/tokens',
      { status: 403 }
    );
  }
  if (res.status === 402) {
    throw new ProviderError(
      'HuggingFace Inference Providers credits are used up for this month.\n' +
        '  Options: wait for the monthly reset, buy pre-paid credits or subscribe to PRO\n' +
        '  at huggingface.co/settings/billing — or switch to a local model:\n' +
        '    ocode chat --provider ollama --model qwen2.5-coder:7b',
      { status: 402, code: PROVIDER_ERROR_CODE.EQUOTA }
    );
  }
}

/** HuggingFace adapter: one SSE delta -> AgentEvent[]. Only place that knows the wire names. */
function parseHfDelta(delta: {
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

export const huggingfaceProvider = {
  id: 'huggingface',
  label: 'HuggingFace',
  tokenEnvVar: 'HF_TOKEN',

  async detect() {
    const token = getToken();
    if (!token) {
      return { available: false, detail: 'no token (set HF_TOKEN or run ocode init)' };
    }
    const key = `${getFetchGeneration()}|${token.slice(0, 8)}`;
    if (detectCache && detectCache.key === key && Date.now() - detectCache.at < DETECT_TTL_MS) {
      return detectCache.value;
    }

    let value;
    try {
      const res = await fetchJson(WHOAMI_URL, {
        headers: { Authorization: `Bearer ${token}` },
        timeoutMs: 5000,
        retries: 1,
        label: 'huggingface probe',
      });
      if (res.status === 401) {
        value = { available: false, detail: 'invalid token' };
      } else if (!res.ok) {
        value = { available: false, detail: `HTTP ${res.status}` };
      } else {
        const who = await res.json().catch((): null => null);
        value = { available: true, detail: who?.name ? `token OK (${who.name})` : 'token OK' };
      }
    } catch (err) {
      value = { available: false, detail: (err as Error).message };
    }
    detectCache = { key, at: Date.now(), value };
    return value;
  },

  async ensureAuth({ interactive, token: explicit }: any = {}) {
    let token = explicit ? String(explicit).trim() : getToken();

    if (!token && !interactive) {
      throw new ProviderError('HuggingFace needs a token. Run "ocode init" or set HF_TOKEN.');
    }
    if (!token) {
      const { passwordPrompt } = await import('../../ui/prompts.ts');
      token = (await passwordPrompt('  HuggingFace access token (hf_...):')).trim();
      if (!token) throw new ProviderError('No token provided.');
    }

    await fetchModels(token); // validate before persisting

    const fromEnv = !explicit && Boolean(process.env.HF_TOKEN);
    if (!fromEnv) {
      updateConfig((cfg) => {
        cfg.tokens.huggingface = token;
      });
    }
    detectCache = null;
    return true;
  },

  async listModels() {
    return fetchModels(getToken());
  },

  async streamChat({ model, messages, tools, signal, onDelta, onReasoning, sampling = {} }: any): Promise<import('../../types.ts').StreamChatResult> {
    const token = getToken();
    if (!token) {
      throw new ProviderError('HuggingFace needs a token. Run "ocode init" or set HF_TOKEN.');
    }

    const body = {
      model,
      messages: normalizeOpenAI(messages),
      stream: true,
      ...(sampling.temperature !== undefined ? { temperature: sampling.temperature } : {}),
      ...(sampling.maxTokens ? { max_tokens: sampling.maxTokens } : {}),
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    };
    traceWireBody(`${baseUrl()}/chat/completions`, body);

    const res = await getFetch()(`${baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      assertAuthOk(res);
      throw new ProviderError(`HuggingFace error ${res.status}: ${await errorBody(res)}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
      });
    }

    let full = '';
    let reasoning = '';
    const acc = new ToolCallAccumulator();
    let finished = false;
    let finishReason = (FINISH_REASON.STOP as import('../../types.ts').StreamChatResult['finishReason']);
    let usage;

    const cancelled = await guardTruncation('HuggingFace', async () => {
      for await (const evt of readSse(res, { signal })) {
        if (evt.data === '[DONE]') {
          finished = true;
          break;
        }

        let payload;
        try {
          payload = JSON.parse(evt.data);
        } catch {
          logger.debug('hf: skipping unparseable SSE data', evt.data.slice(0, 120));
          continue;
        }

        if (payload.error) {
          throw new ProviderError(
            `HuggingFace error: ${payload.error.message ?? payload.error}`,
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
        for (const event of parseHfDelta(delta)) {
          traceStreamEvent('HuggingFace', event);
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
          break;
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
  },

  clearCache() {
    detectCache = null;
  },
};

function normalizeOpenAI(messages: import('../../types.ts').Message[]) {
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

