import { PROVIDER_ERROR_CODE } from '../../protocol';
import { loadConfig, updateConfig } from '../../core/config';
import { fetchJson, errorBody, getFetchGeneration } from './http';
import { streamOpenAIChat } from './openai-chat';
import { ProviderError } from '../../core/errors';

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
    return streamOpenAIChat({
      label: 'HuggingFace',
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
