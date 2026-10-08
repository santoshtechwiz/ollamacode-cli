import { PROVIDER_ERROR_CODE } from '../protocol';
import { discoverUserProviders, getProvider, getProviders, resolveProviderId, knownProviderIds } from './providers/registry';
import { parseProviderMode, resolveProviderForMode } from './providers/mode';
import { ollamaCloudProvider } from './providers/ollama-cloud';
import { loadConfig, updateConfig } from '../core/config';
import { select } from '../ui/prompts';
import { logger } from '../core/logger';
import { TcError } from '../core/errors';

const GIB = 1024 ** 3;

export function formatModelSize(bytes?: number): string | undefined {
  return bytes ? `${(bytes / GIB).toFixed(1)}GB` : undefined;
}

export async function probeProviders(): Promise<{ provider: import('../types.ts').ProviderDef; status: import('../types.ts').ProviderDetect; }[]> {
  await discoverUserProviders();
  return Promise.all(
    getProviders().map(async (provider) => ({ provider, status: await provider.detect() }))
  );
}

function unavailableMessage(statuses: { provider: import('../types.ts').ProviderDef; status: import('../types.ts').ProviderDetect; }[]): string {
  const lines = statuses.map((s) => `    ${s.provider.label}: ${s.status.detail}`).join('\n');
  return `No LLM provider is available.\n${lines}\n\n  Start Ollama with "ollama serve", or run "ocode init" to configure HuggingFace.`;
}

async function resolveProvider({ providerId, interactive = false, requireAvailable = false }: any = {}): Promise<import('../types.ts').ProviderDef> {
  await discoverUserProviders();

  if (providerId) {
    const provider = getProvider(providerId);
    if (!provider) {
      throw new TcError(
        `Unknown provider "${providerId}". Available: ${knownProviderIds().join(', ')}`,
        { code: PROVIDER_ERROR_CODE.EPROVIDER_UNKNOWN }
      );
    }
    if (requireAvailable) {
      const status = await provider.detect();
      if (!status.available) {
        throw new TcError(`${provider.label} is not available: ${status.detail}`, {
          code: PROVIDER_ERROR_CODE.EPROVIDER_UNAVAILABLE,
        });
      }
    }
    return provider;
  }

  // No flag and no stored choice: the provider mode names the Ollama backend (cloud-first by default).
  const mode = parseProviderMode(loadConfig().providerMode);
  // Only cloud-first/cloud-only ever read the cloud status (mode.ts).
  const cloud: import('./providers/mode.ts').CloudStatus =
    mode === 'cloud-first' || mode === 'cloud-only'
      ? (await ollamaCloudProvider.cloudStatus()).status
      : 'offline';
  const decision = resolveProviderForMode({ mode, cloud, explicitProviderId: null, storedProviderId: null });
  if ('error' in decision) {
    throw new TcError(decision.error, { code: PROVIDER_ERROR_CODE.EPROVIDER_UNAVAILABLE });
  }
  const preferred = getProvider(decision.providerId);
  if (preferred && (await preferred.detect()).available) return preferred;
  if (mode === 'cloud-only' || mode === 'local-only') {
    throw new TcError(
      `${preferred?.label ?? decision.providerId} is not available and provider mode is ${mode} — refusing to cross over`,
      { code: PROVIDER_ERROR_CODE.EPROVIDER_UNAVAILABLE }
    );
  }

  const statuses = await probeProviders();
  const available = statuses.filter((s) => s.status.available);
  if (available.length === 0) {
    throw new TcError(unavailableMessage(statuses), { code: PROVIDER_ERROR_CODE.EPROVIDER_NONE });
  }

  if (interactive && available.length > 1) {
    const picked = await select(
      'Multiple backends are available — pick one:',
      available.map(({ provider, status }: any) => ({
        label: provider.label,
        value: provider.id,
        hint: status.detail,
      }))
    );
    const chosen = getProvider(String(picked));
    if (chosen) return chosen;
  }

  logger.info(`using ${available[0].provider.label} (${available[0].status.detail})`);
  return available[0].provider;
}

export async function resolveModel(provider: import('../types.ts').ProviderDef, { model, interactive = false }: any = {}): Promise<string> {
  if (model) return model;

  const saved = loadConfig().models[provider.id];
  if (saved && !interactive) return saved;

  const models = await provider.listModels();
  if (models.length === 0) {
    throw new TcError(
      provider.id === 'ollama'
        ? 'Ollama has no models installed. Install one with: ollama pull qwen2.5-coder:7b'
        : `${provider.label} returned no models.`,
      { code: PROVIDER_ERROR_CODE.ENOMODELS }
    );
  }

  if (saved && models.some((m) => m.name === saved)) return saved;

  if (interactive) {
    const picked = await select(
      `Pick a model for ${provider.label}:`,
      models.slice(0, 15).map((m) => ({
        label: m.name,
        value: m.name,
        hint: formatModelSize(m.size),
      }))
    );
    if (picked) return String(picked);
  }

  logger.info(`using model ${models[0].name}`);
  return models[0].name;
}

export async function resolveSession(flags: { provider?: string; model?: string; token?: string; } = {}, { interactive = false, persist = true }: any = {}): Promise<{ provider: import('../types.ts').ProviderDef; model: string; }> {
  const cfg = loadConfig();
  const requested = flags.provider ? resolveProviderId(flags.provider) : cfg.activeProvider;

  const provider = await resolveProvider({
    providerId: requested ?? undefined,
    interactive,
  });

  await provider.ensureAuth?.({ interactive, token: flags.token });

  const model = await resolveModel(provider, {
    model: flags.model,
    interactive: interactive && !flags.model,
  });

  // A flag is for this run; the config is the durable default.
  if (persist) {
    rememberSession({
      provider,
      model: flags.model ? undefined : model,
      setActive: !flags.provider,
    });
  }

  return { provider, model };
}

export function rememberSession({ provider, model, setActive = true }: any) {
  updateConfig((c) => {
    if (setActive) c.activeProvider = provider.id;
    if (model) c.models[provider.id] = model;
  });
}

