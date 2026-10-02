import { PROVIDER_ERROR_CODE } from '../../protocol';
import { loadConfig, updateConfig } from '../../core/config';
import { fetchJson, getFetch, errorBody, getFetchGeneration, traceWireBody } from './http';
import { toOllamaMessages } from './ollama';
import { ollamaChatBody } from './_sampling';
import { consumeOllamaStream } from './_ollama-stream';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';

const DEFAULT_BASE = 'https://ollama.com';
const DETECT_TTL_MS = 60_000;

function baseUrl() {
  return (process.env.OLLAMA_CLOUD_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

function getToken(): string {
  const raw = process.env.OLLAMA_API_KEY || loadConfig().tokens?.['ollama-cloud'] || '';
  return String(raw).trim();
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

let detectCache: { key: string; at: number; value: import('../../types.ts').ProviderDetect; } | null = null;
const modelInfoCache = new Map<string, { contextLength?: number; capabilities?: string[]; remote?: boolean; supportsTools?: boolean; supportsThinking?: boolean; }>();

function assertAuthOk(res: Response) {
  if (res.status === 401) {
    throw new ProviderError('Invalid Ollama Cloud API key. Create one at ollama.com/settings/keys', {
      status: 401,
    });
  }
}

export const ollamaCloudProvider = {
  id: 'ollama-cloud',
  label: 'Ollama Cloud',
  tokenEnvVar: 'OLLAMA_API_KEY',

  async detect() {
    const token = getToken();
    if (!token) {
      return { available: false, detail: 'no key (set OLLAMA_API_KEY or run ocode init)' };
    }
    const key = `${getFetchGeneration()}|${token.slice(0, 8)}`;
    if (detectCache && detectCache.key === key && Date.now() - detectCache.at < DETECT_TTL_MS) {
      return detectCache.value;
    }

    let value;
    try {
      const res = await fetchJson(`${baseUrl()}/api/me`, {
        method: 'POST',
        headers: authHeaders(token),
        timeoutMs: 6000,
        retries: 1,
        label: 'ollama cloud probe',
      });
      if (res.status === 401) {
        value = { available: false, detail: 'invalid key' };
      } else if (!res.ok) {
        value = { available: false, detail: `HTTP ${res.status}` };
      } else {
        value = { available: true, detail: 'key OK' };
      }
    } catch (err) {
      value = { available: false, detail: (err as Error).message };
    }
    detectCache = { key, at: Date.now(), value };
    return value;
  },

  /** Tri-state cloud availability, owned by the provider layer (§17). */
  async cloudStatus(): Promise<{ status: import('./mode.ts').CloudStatus; detail: string; }> {
    const token = getToken();
    if (!token) {
      return { status: 'unavailable', detail: 'no key (set OLLAMA_API_KEY or run ocode init)' };
    }
    try {
      const res = await fetchJson(`${baseUrl()}/api/me`, {
        method: 'POST',
        headers: authHeaders(token),
        timeoutMs: 6000,
        retries: 1,
        label: 'ollama cloud status',
      });
      if (res.status === 401) return { status: 'unavailable', detail: 'invalid key' };
      if (!res.ok) return { status: 'error', detail: `HTTP ${res.status}` };
      return { status: 'available', detail: 'key OK' };
    } catch (err) {
      return { status: 'error', detail: (err as Error).message };
    }
  },

  async ensureAuth({ interactive, token: explicit }: { interactive?: boolean; token?: string; } = {}) {
    let token = explicit ? String(explicit).trim() : getToken();

    if (!token && !interactive) {
      throw new ProviderError('Ollama Cloud needs an API key. Run "ocode init" or set OLLAMA_API_KEY.');
    }
    if (!token) {
      const { passwordPrompt } = await import('../../ui/prompts.ts');
      token = (await passwordPrompt('  Ollama Cloud API key:')).trim();
      if (!token) throw new ProviderError('No API key provided.');
    }

    const res = await fetchJson(`${baseUrl()}/api/me`, {
      method: 'POST',
      headers: authHeaders(token),
      timeoutMs: 8000,
      label: 'ollama cloud auth check',
    });
    assertAuthOk(res);
    if (!res.ok) {
      throw new ProviderError(`Ollama Cloud error ${res.status}: ${await errorBody(res)}`, { status: res.status });
    }

    const fromEnv = !explicit && Boolean(process.env.OLLAMA_API_KEY);
    if (!fromEnv) {
      updateConfig((cfg) => {
        cfg.tokens['ollama-cloud'] = token;
      });
    }
    detectCache = null;
    return true;
  },

  async listModels() {
    const token = getToken();
    const res = await fetchJson(`${baseUrl()}/api/tags`, {
      headers: authHeaders(token),
      timeoutMs: 10_000,
      label: 'ollama cloud model list',
    });
    if (!res.ok) {
      throw new ProviderError(`Ollama Cloud error ${res.status}: ${await errorBody(res)}`, { status: res.status });
    }
    const data = await res.json();
    return (data?.models ?? []).map((m: { name: string; size?: number; }) => ({ name: m.name, size: m.size }));
  },

  async streamChat({ model, messages, tools, signal, onDelta, onReasoning, sampling = {} }: import('../../types.ts').StreamChatParams): Promise<import('../../types.ts').StreamChatResult> {
    const token = getToken();
    if (!token) {
      throw new ProviderError('Ollama Cloud needs an API key. Run "ocode init" or set OLLAMA_API_KEY.');
    }

    const thinking = sampling.think
      ? Boolean((await this.modelInfo(model))?.supportsThinking)
      : false;

    const body = ollamaChatBody({ model, messages, tools, sampling, thinking, toMessages: toOllamaMessages });
    traceWireBody(`${baseUrl()}/api/chat`, body);

    const res = await getFetch()(`${baseUrl()}/api/chat`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      assertAuthOk(res);
      const detail = await errorBody(res);
      if (res.status === 404) {
        throw new ProviderError(`Ollama Cloud model not found: ${model} — check the exact tag at ollama.com/library`, {
          status: 404,
        });
      }
      if (/does not support tools/i.test(detail)) {
        throw new ProviderError(`${model} does not support tool calling`, {
          code: PROVIDER_ERROR_CODE.ETOOLS_UNSUPPORTED,
          status: res.status,
        });
      }
      throw new ProviderError(`Ollama Cloud error ${res.status}: ${detail}`, {
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
      });
    }

    // Same wire format as the local daemon, so the same numbers are here for the asking — they were simply never read, which made every timing diagnostic local-only.
    return consumeOllamaStream('Ollama Cloud', model, res, signal, {
      onDelta,
      onReasoning,
      logExtra: (state) => ` · think=${body.think} · done=${state.doneReason ?? 'stop'}`,
    });
  },

  /** The same `/api/show` probe the local provider runs, with a bearer token. */
  async modelInfo(model: string): Promise<{ contextLength?: number; capabilities?: string[]; remote?: boolean; supportsTools?: boolean; supportsThinking?: boolean; }> {
    const cached = modelInfoCache.get(model);
    if (cached) return cached;
    const token = getToken();
    if (!token) return {};
    try {
      const res = await fetchJson(`${baseUrl()}/api/show`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ model }),
        timeoutMs: 10_000,
        retries: 1,
        label: 'ollama cloud model info',
      });
      if (!res.ok) return {};
      const data = await res.json();
      const info = data?.model_info ?? {};
      const key = Object.keys(info).find((k) => k.endsWith('.context_length'));
      const declared = Array.isArray(data?.capabilities) ? data.capabilities : null;
      const value = {
        contextLength: key ? Number(info[key]) : undefined,
        capabilities: declared ?? [],
        // Always: this provider is somebody else's GPU by definition, which is what the generation budget wants to know.
        remote: true,
        supportsTools: declared ? declared.includes('tools') : undefined,
        supportsThinking: declared ? declared.includes('thinking') : false,
      };
      modelInfoCache.set(model, value);
      return value;
    } catch (err) {
      logger.debug(`ollama cloud modelInfo failed: ${(err as Error).message}`);
      return {};
    }
  },

  clearCache() {
    detectCache = null;
    modelInfoCache.clear();
  },
};

