// NVIDIA's hosted models (build.nvidia.com), over the OpenAI chat-completions format (see openai-chat.ts). Its model
// list says nothing about a model's window or tool support, so neither is claimed here.
import { PROVIDER_ERROR_CODE } from '../../protocol';
import { loadConfig, updateConfig } from '../../core/config';
import { fetchJson, errorBody, getFetchGeneration } from './http';
import { streamOpenAIChat } from './openai-chat';
import { ProviderError } from '../../core/errors';

const DEFAULT_BASE = 'https://integrate.api.nvidia.com/v1';
const DETECT_TTL_MS = 60_000;
const NEEDS_KEY = 'NVIDIA needs a key. Run "ocode init --provider nvidia" or set NVIDIA_API_KEY.';

function baseUrl() {
  return (process.env.NVIDIA_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

function getToken(): string {
  return String(process.env.NVIDIA_API_KEY || loadConfig().tokens?.nvidia || '').trim();
}

function authHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

function assertAuthOk(res: Response) {
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('Invalid NVIDIA key. Create one at build.nvidia.com (your profile → API Keys); it starts with nvapi-', { status: res.status });
  }
  if (res.status === 402) {
    throw new ProviderError(
      'NVIDIA API credits are used up.\n' +
        '  See your credits at build.nvidia.com, or switch to a local model:\n' +
        '    ocode chat --provider ollama --model qwen2.5-coder:7b',
      { status: 402, code: PROVIDER_ERROR_CODE.EQUOTA }
    );
  }
}

async function fetchModels(token: string): Promise<{ name: string }[]> {
  const res = await fetchJson(`${baseUrl()}/models`, {
    headers: authHeaders(token),
    timeoutMs: 15_000,
    retries: 1,
    label: 'nvidia model list',
  });
  assertAuthOk(res);
  if (!res.ok) throw new ProviderError(`NVIDIA error ${res.status}: ${await errorBody(res)}`, { status: res.status });
  const data = (await res.json())?.data;
  if (!Array.isArray(data)) throw new ProviderError('NVIDIA returned an unexpected model list payload');
  return data.map((m: { id?: string }) => ({ name: String(m?.id ?? '') })).filter((m) => m.name);
}

let detectCache: any = null;

export const nvidiaProvider = {
  id: 'nvidia',
  label: 'NVIDIA',
  tokenEnvVar: 'NVIDIA_API_KEY',

  async detect() {
    const token = getToken();
    if (!token) return { available: false, detail: 'no key (set NVIDIA_API_KEY or run ocode init --provider nvidia)' };
    const key = `${getFetchGeneration()}|${token.slice(0, 12)}`;
    if (detectCache && detectCache.key === key && Date.now() - detectCache.at < DETECT_TTL_MS) return detectCache.value;
    let value;
    try {
      const models = await fetchModels(token);
      value = { available: true, detail: `key set · ${models.length} models` };
    } catch (err) {
      value = { available: false, detail: (err as Error).message.split('\n')[0] };
    }
    detectCache = { key, at: Date.now(), value };
    return value;
  },

  async ensureAuth({ interactive, token: explicit }: any = {}) {
    let token = explicit ? String(explicit).trim() : getToken();
    if (!token && !interactive) throw new ProviderError(NEEDS_KEY);
    if (!token) {
      const { passwordPrompt } = await import('../../ui/prompts.ts');
      token = (await passwordPrompt('  NVIDIA API key (nvapi-...):')).trim();
      if (!token) throw new ProviderError('No key provided.');
    }
    // The model list is the one call that needs no model; a key it does not check is checked on the first request.
    await fetchModels(token);
    const fromEnv = !explicit && Boolean(process.env.NVIDIA_API_KEY);
    if (!fromEnv) {
      updateConfig((cfg) => {
        cfg.tokens.nvidia = token;
      });
    }
    detectCache = null;
    return true;
  },

  async listModels() {
    return fetchModels(getToken());
  },

  /** Somebody else's GPU; the list gives no window or tool support, so those stay unknown. */
  async modelInfo(): Promise<{ remote: boolean }> {
    return { remote: true };
  },

  async streamChat({ model, messages, tools, signal, onDelta, onReasoning, sampling = {} }: any): Promise<import('../../types.ts').StreamChatResult> {
    const token = getToken();
    if (!token) throw new ProviderError(NEEDS_KEY);
    return streamOpenAIChat({
      label: 'NVIDIA',
      url: `${baseUrl()}/chat/completions`,
      headers: authHeaders(token),
      rejectResponse: assertAuthOk,
      model, messages, tools, signal, onDelta, onReasoning, sampling,
    });
  },

  clearCache() {
    detectCache = null;
  },
};
