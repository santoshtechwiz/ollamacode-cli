import { PROVIDER_ERROR_CODE, ROLE } from '../../protocol';
import { fetchJson, getFetch, errorBody, withTimeout, getFetchGeneration, traceWireBody, isUnreachable, unreachableError } from './http';
import { ollamaChatBody } from './_sampling';
import { consumeOllamaStream } from './_ollama-stream';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';

const DETECT_TIMEOUT_MS = 1500;
const DETECT_TIMEOUT_REMOTE_MS = 6000;
const DETECT_TTL_MS = 30_000;
const DEFAULT_PORT = 11434;

function isRemoteBase(base: string) {
  return /ngrok|colab/i.test(base) || base.startsWith('https://');
}

/** Is the daemon supposed to be on this machine? */
function isLoopbackBase(base: string): boolean {
  return /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/|$)/i.test(base);
}

function ollamaHeaders(base: string): Record<string, string> {
  const h: Record<string, string> = {};
  if (base && isRemoteBase(base)) h['ngrok-skip-browser-warning'] = 'true';
  return h;
}

function candidateBases(): string[] {
  const env = process.env.OLLAMA_HOST;
  if (env) {
    const base = env.startsWith('http') ? env.replace(/\/+$/, '') : `http://${env}`;
    return [base];
  }
  const port = Number(process.env.OLLAMA_PORT) || DEFAULT_PORT;
  return [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
}

interface OllamaModelInfo {
  contextLength?: number;
  parameterSize?: string;
  family?: string;
  capabilities?: string[];
  supportsTools?: boolean;
  supportsThinking?: boolean;
}

let detectCache: { key: string; at: number; value: import('../../types.ts').ProviderDetect; } | null = null;
let detectPromise: Promise<import('../../types.ts').ProviderDetect> | null = null;

const modelInfoCache = new Map<string, OllamaModelInfo>();

function cacheKey() {
  return `${getFetchGeneration()}|${process.env.OLLAMA_HOST ?? ''}|${process.env.OLLAMA_PORT ?? ''}`;
}

let tagsCache: { key: string; at: number; models: any[]; } | null = null;
const TAGS_CACHE_TTL_MS = 30_000;

/** Only /api/tags marks cloud-proxied models as remote (/api/show never does); cached like detect()'s list. */
async function fetchTagEntry(base: string, model: string): Promise<any> {
  const key = cacheKey();
  if (!tagsCache || tagsCache.key !== key || Date.now() - tagsCache.at >= TAGS_CACHE_TTL_MS) {
    try {
      const res = await fetchJson(`${base}/api/tags`, {
        timeoutMs: isRemoteBase(base) ? 12_000 : 10_000,
        headers: ollamaHeaders(base),
        label: 'ollama model list (remote check)',
      });
      const data = res.ok ? await res.json() : null;
      tagsCache = { key, at: Date.now(), models: Array.isArray(data?.models) ? data.models : [] };
    } catch (err) {
      logger.debug(`ollama tags lookup failed: ${(err as Error).message}`);
      tagsCache = { key, at: Date.now(), models: [] };
    }
  }
  return tagsCache.models.find((m: any) => m?.name === model || m?.model === model);
}

export function toOllamaMessages(messages: import('../../types.ts').Message[]) {
  return messages.map((m) => {
    if (m.role === ROLE.ASSISTANT && m.tool_calls?.length) {
      return {
        role: ROLE.ASSISTANT,
        content: m.content ?? '',
        // Ollama's templates put it back in the model's own reasoning channel; one that has none leaves it out.
        ...(m.reasoning ? { thinking: m.reasoning } : {}),
        tool_calls: m.tool_calls.map((tc) => ({
          function: { name: tc.function.name, arguments: tc.function.arguments ?? {} },
        })),
      };
    }
    if (m.role === ROLE.TOOL) {
      return {
        role: ROLE.TOOL,
        content: String(m.content ?? ''),
        ...(m.name ? { tool_name: m.name } : {}),
      };
    }
    return { role: m.role, content: m.content ?? '' };
  });
}

export const ollamaProvider = {
  id: 'ollama',
  label: 'Local Ollama',

  async detect() {
    const key = cacheKey();
    if (detectCache && detectCache.key === key && Date.now() - detectCache.at < DETECT_TTL_MS) {
      return detectCache.value;
    }
    if (detectPromise && detectCache && detectCache.key === key) return detectPromise;
    detectPromise = (async () => {
      const failures: string[] = [];
      let value: { available: boolean; detail: string; base?: string; } = { available: false, detail: 'not reachable' };

      for (const base of candidateBases()) {
        const timeout = isRemoteBase(base) ? DETECT_TIMEOUT_REMOTE_MS : DETECT_TIMEOUT_MS;
        const t = withTimeout(undefined, timeout);
        try {
          const res = await getFetch()(`${base}/api/tags`, {
            signal: t.signal,
            headers: ollamaHeaders(base),
            keepalive: true,
          });
          if (!res.ok) {
            failures.push(`${base}: HTTP ${res.status}`);
            continue;
          }
          const data = await res.json();
          const n = data?.models?.length ?? 0;
          value = { available: true, detail: `${n} model${n === 1 ? '' : 's'} installed`, base };
          break;
        } catch (err) {
          const reason = t.timedOut ? 'timeout' : (err as Error).message;
          failures.push(`${base}: ${reason}`);
        } finally {
          t.dispose();
        }
      }

      if (!value.available) {
        value = { available: false, detail: `not reachable (${failures.join('; ')})` };
      }
      if (value.available) detectCache = { key, at: Date.now(), value };
      return value;
    })();
    try {
      return await detectPromise;
    } finally {
      detectPromise = null;
    }
  },

  async ensureAuth() {
    return true; // local daemon needs no credentials
  },

  async listModels() {
    const base = await this._base();
    const res = await fetchJson(`${base}/api/tags`, {
      timeoutMs: isRemoteBase(base) ? 12_000 : 10_000,
      headers: ollamaHeaders(base),
      label: 'ollama model list',
    });
    if (!res.ok) {
      throw new ProviderError(`Ollama error ${res.status}: ${await errorBody(res)}`, {
        status: res.status,
      });
    }
    const data = await res.json();
    return (data?.models ?? []).map((m: { name: string; size?: number; }) => ({ name: m.name, size: m.size }));
  },

  async streamChat({ model, messages, tools, signal, onDelta, onReasoning, sampling = {} }: import('../../types.ts').StreamChatParams): Promise<import('../../types.ts').StreamChatResult> {
    const base = await this._base();

    const thinking = sampling.think
      ? Boolean((await this.modelInfo(model))?.supportsThinking)
      : false;

    const body = ollamaChatBody({ model, messages, tools, sampling, thinking, toMessages: toOllamaMessages });
    traceWireBody(`${base}/api/chat`, body);

    let res: Response;
    try {
      res = await getFetch()(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson', ...ollamaHeaders(base) },
        body: JSON.stringify(body),
        signal,
        keepalive: true,
      });
    } catch (err) {
      // A daemon that is not running is the most common failure here and the easiest to fix, and it used to reach the user as "fetch failed".
      if (isUnreachable(err)) {
        throw unreachableError(
          base,
          isLoopbackBase(base)
            ? 'is the Ollama daemon running? start it with: ollama serve'
            : 'check that $OLLAMA_HOST is right and that the host is up',
          err
        );
      }
      throw err;
    }

    if (!res.ok) {
      const detail = await errorBody(res);
      if (res.status === 404) {
        // What is installed on the host is a question with a live answer (`ocode models`); it is not a list to hardcode into an error string.
        const hostHint = isRemoteBase(base) ? ` on the host behind $OLLAMA_HOST (${base}), not locally` : '';
        throw new ProviderError(`Ollama model not found: ${model}${hostHint} — run: ollama pull ${model}${hostHint}.`, {
          status: 404,
        });
      }
      if (/does not support tools/i.test(detail)) {
        throw new ProviderError(`${model} does not support tool calling`, {
          code: PROVIDER_ERROR_CODE.ETOOLS_UNSUPPORTED,
          status: res.status,
        });
      }
      throw new ProviderError(`Ollama error ${res.status}: ${detail}`, {
        status: res.status,
        retryable: res.status >= 500,
      });
    }

    return consumeOllamaStream('Ollama', model, res, signal, {
      onDelta,
      onReasoning,
      // The one line that makes a slow turn diagnosable: what we asked for (think / num_ctx / num_predict), what came back (done_reason), and where the time went.
      logExtra: (state) =>
        ` · think=${body.think}` +
        ` · num_ctx=${body.options.num_ctx ?? 'default'} num_predict=${body.options.num_predict ?? 'default'}` +
        ` · done=${state.doneReason ?? 'stop'}`,
    });
  },

  async modelInfo(model: string): Promise<OllamaModelInfo> {
    const cached = modelInfoCache.get(model);
    if (cached) return cached;
    try {
      const base = await this._base();
      const remoteBase = isRemoteBase(base);
      const [res, tagEntry] = await Promise.all([
        fetchJson(`${base}/api/show`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...ollamaHeaders(base) },
          body: JSON.stringify({ model }),
          timeoutMs: remoteBase ? 10_000 : 5000,
          retries: remoteBase ? 1 : 0,
          label: 'ollama model info',
        }),
        fetchTagEntry(base, model),
      ]);
      if (!res.ok) return {};
      const data = await res.json();
      const info = data?.model_info ?? {};
      const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
      const declared = Array.isArray(data?.capabilities) ? data.capabilities : null;
      const remote = Boolean(data?.remote_model || data?.remote_host || tagEntry?.remote_model || tagEntry?.remote_host);
      const value = {
        contextLength: key ? Number(info[key]) : undefined,
        parameterSize: data?.details?.parameter_size,
        family: data?.details?.family,
        capabilities: declared ?? [],
        remote,
        remoteModel: data?.remote_model ?? tagEntry?.remote_model,
        supportsTools: declared ? declared.includes('tools') : undefined,
        supportsThinking: declared ? declared.includes('thinking') : false,
      };
      modelInfoCache.set(model, value);
      return value;
    } catch (err) {
      logger.debug(`ollama modelInfo failed: ${ (err as Error).message}`);
      return {};
    }
  },

  async isCpuOnly(model?: string): Promise<boolean | undefined> {
    try {
      const base = await this._base();
      const remote = isRemoteBase(base);
      if (remote) return undefined;
      const res = await fetchJson(`${base}/api/ps`, {
        timeoutMs: 4000,
        retries: 0,
        headers: ollamaHeaders(base),
        label: 'ollama ps',
      });
      if (!res.ok) return undefined;
      const data = await res.json();
      const loaded = Array.isArray(data?.models) ? data.models : [];
      if (loaded.length === 0) return undefined;
      const untag = (name: string | undefined) => String(name ?? '').split(':')[0];
      const wanted = model ? untag(model) : '';
      const matches = (m: { name?: string; model?: string; }) =>
        m?.name === model ||
        m?.model === model ||
        (!String(model ?? '').includes(':') && (untag(m?.name) === wanted || untag(m?.model) === wanted));
      const mine = model ? loaded.filter(matches) : loaded;
      if (mine.length === 0) return undefined;
      return mine.every((m: { size_vram?: number; }) => Number(m?.size_vram ?? 0) === 0);
    } catch {
      return undefined;
    }
  },

  async residentModels(): Promise<string[]> {
    try {
      const base = await this._base();
      if (isRemoteBase(base)) return [];
      const res = await fetchJson(`${base}/api/ps`, {
        timeoutMs: 4000,
        retries: 0,
        headers: ollamaHeaders(base),
        label: 'ollama ps',
      });
      if (!res.ok) return [];
      const data = await res.json();
      const loaded = Array.isArray(data?.models) ? data.models : [];
      return loaded.map((m: { model?: string; name?: string; }) => String(m?.model ?? m?.name ?? '')).filter(Boolean);
    } catch (err) {
      logger.debug(`ollama ps failed: ${ (err as Error).message}`);
      return [];
    }
  },

  async _base() {
    const st = await this.detect();
    if (st.base) return st.base;
    return candidateBases()[0];
  },

  clearCache() {
    detectCache = null;
    detectPromise = null;
    modelInfoCache.clear();
    tagsCache = null;
  },
};

