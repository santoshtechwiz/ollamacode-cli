// OpenRouter: one key for many hosted models, over the OpenAI chat-completions format (see openai-chat.ts).
import { PROVIDER_ERROR_CODE } from '../../protocol';
import { loadConfig, updateConfig } from '../../core/config';
import { fetchJson, errorBody, getFetchGeneration } from './http';
import { streamOpenAIChat } from './openai-chat';
import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';

const DEFAULT_BASE = 'https://openrouter.ai/api/v1';
const DETECT_TTL_MS = 60_000;
const MODELS_TTL_MS = 10 * 60_000;

function baseUrl() {
  return (process.env.OPENROUTER_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
}

function getToken(): string {
  return String(process.env.OPENROUTER_API_KEY || loadConfig().tokens?.openrouter || '').trim();
}

function authHeaders(token: string) {
  // X-Title names the app on the person's OpenRouter activity page.
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Title': 'ocode' };
}

/** One model as OpenRouter lists it: only the fields ocode reads. */
interface ListedModel {
  id: string;
  context_length?: number;
  supported_parameters?: string[];
  /** USD per token, as strings ("0" for a free model). */
  pricing?: { prompt?: string; completion?: string };
}

/** Free when both prices are listed and are zero; unset when the list gives no prices. */
function isFree(model: ListedModel): boolean | undefined {
  const { prompt, completion } = model.pricing ?? {};
  if (prompt === undefined || completion === undefined) return undefined;
  return Number(prompt) === 0 && Number(completion) === 0;
}

function assertAuthOk(res: Response) {
  if (res.status === 401) {
    throw new ProviderError('Invalid OpenRouter key. Create one at openrouter.ai/settings/keys', { status: 401 });
  }
  if (res.status === 402) {
    throw new ProviderError(
      'OpenRouter credits are used up.\n' +
        '  Add credits at openrouter.ai/settings/credits, pick a free model (its id ends in ":free"),\n' +
        '  or switch to a local model:\n' +
        '    ocode chat --provider ollama --model qwen2.5-coder:7b',
      { status: 402, code: PROVIDER_ERROR_CODE.EQUOTA }
    );
  }
}

let detectCache: any = null;
let modelsCache: { at: number; models: ListedModel[] } | null = null;

/** The models that take tools: ocode works through tool calls, so a model without them cannot do the work. */
async function fetchModels(token: string): Promise<ListedModel[]> {
  if (modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return modelsCache.models;
  const res = await fetchJson(`${baseUrl()}/models`, {
    headers: authHeaders(token),
    timeoutMs: 15_000,
    retries: 1,
    label: 'openrouter model list',
  });
  assertAuthOk(res);
  if (!res.ok) {
    throw new ProviderError(`OpenRouter error ${res.status}: ${await errorBody(res)}`, { status: res.status });
  }
  const data = (await res.json())?.data;
  if (!Array.isArray(data)) throw new ProviderError('OpenRouter returned an unexpected model list payload');
  const models = data.filter((m: ListedModel) => m?.id && m.supported_parameters?.includes('tools'));
  modelsCache = { at: Date.now(), models };
  return models;
}

export const openrouterProvider = {
  id: 'openrouter',
  label: 'OpenRouter',
  tokenEnvVar: 'OPENROUTER_API_KEY',

  async detect() {
    const token = getToken();
    if (!token) return { available: false, detail: 'no key (set OPENROUTER_API_KEY or run ocode init --provider openrouter)' };
    const key = `${getFetchGeneration()}|${token.slice(0, 12)}`;
    if (detectCache && detectCache.key === key && Date.now() - detectCache.at < DETECT_TTL_MS) return detectCache.value;

    let value;
    try {
      const res = await fetchJson(`${baseUrl()}/key`, {
        headers: authHeaders(token),
        timeoutMs: 5000,
        retries: 1,
        label: 'openrouter probe',
      });
      if (res.status === 401) value = { available: false, detail: 'invalid key' };
      else if (!res.ok) value = { available: false, detail: `HTTP ${res.status}` };
      else {
        const info = (await res.json().catch((): null => null))?.data;
        const left = typeof info?.limit_remaining === 'number' ? ` · $${info.limit_remaining.toFixed(2)} left` : '';
        value = { available: true, detail: `key OK${info?.is_free_tier ? ' (free tier)' : ''}${left}` };
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
      throw new ProviderError('OpenRouter needs a key. Run "ocode init --provider openrouter" or set OPENROUTER_API_KEY.');
    }
    if (!token) {
      const { passwordPrompt } = await import('../../ui/prompts.ts');
      token = (await passwordPrompt('  OpenRouter API key (sk-or-...):')).trim();
      if (!token) throw new ProviderError('No key provided.');
    }

    // The model list answers without a key, so the key is checked where it counts.
    const res = await fetchJson(`${baseUrl()}/key`, { headers: authHeaders(token), timeoutMs: 10_000, label: 'openrouter key check' });
    assertAuthOk(res);
    if (!res.ok) throw new ProviderError(`OpenRouter error ${res.status}: ${await errorBody(res)}`, { status: res.status });

    const fromEnv = !explicit && Boolean(process.env.OPENROUTER_API_KEY);
    if (!fromEnv) {
      updateConfig((cfg) => {
        cfg.tokens.openrouter = token;
      });
    }
    detectCache = null;
    return true;
  },

  async listModels() {
    return (await fetchModels(getToken())).map((m) => {
      const free = isFree(m);
      return free === undefined ? { name: m.id } : { name: m.id, free };
    });
  },

  /** What the model list says about one model: its window and whether it takes tools and reasons. */
  async modelInfo(model: string): Promise<{ contextLength?: number; remote: boolean; supportsTools?: boolean; supportsThinking?: boolean }> {
    try {
      const found = (await fetchModels(getToken())).find((m) => m.id === model);
      // Not in the list of tool-taking models: either it takes no tools or the id is wrong; the request will say which.
      if (!found) return { remote: true };
      return {
        contextLength: Number(found.context_length) || undefined,
        remote: true,
        supportsTools: true,
        supportsThinking: found.supported_parameters?.includes('reasoning') ?? false,
      };
    } catch (err) {
      logger.debug(`openrouter modelInfo failed: ${(err as Error).message}`);
      return { remote: true };
    }
  },

  async streamChat({ model, messages, tools, signal, onDelta, onReasoning, sampling = {} }: any): Promise<import('../../types.ts').StreamChatResult> {
    const token = getToken();
    if (!token) throw new ProviderError('OpenRouter needs a key. Run "ocode init --provider openrouter" or set OPENROUTER_API_KEY.');
    return streamOpenAIChat({
      label: 'OpenRouter',
      url: `${baseUrl()}/chat/completions`,
      headers: authHeaders(token),
      rejectResponse: assertAuthOk,
      model, messages, tools, signal, onDelta, onReasoning, sampling,
      // Token counts in the stream, so the context meter reads what was used rather than an estimate.
      extraBody: { usage: { include: true } },
    });
  },

  clearCache() {
    detectCache = null;
    modelsCache = null;
  },
};
