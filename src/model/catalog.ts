import os from 'node:os';

import { logger } from '../core/logger';

const catalogCache = new Map<string, import('./router.ts').Candidate[]>();

async function residentModels(provider: import('../types.ts').ProviderDef & { residentModels?: () => Promise<string[]>; }): Promise<Set<string>> {
  if (typeof provider.residentModels !== 'function') return new Set();
  try {
    return new Set(await provider.residentModels());
  } catch (err) {
    logger.debug(`resident model probe failed: ${ (err as Error).message}`);
    return new Set();
  }
}

async function collectCandidates(provider: import('../types.ts').ProviderDef & { modelInfo?: (m: string) => Promise<any>; residentModels?: () => Promise<string[]>; }, { force = false, limit = 25 }: { force?: boolean; limit?: number; } = {}): Promise<import('./router.ts').Candidate[]> {
  const resident = await residentModels(provider);

  const cached = catalogCache.get(provider.id);
  if (cached && !force) {
    return cached.map((c) => ({ ...c, resident: resident.has(c.name) }));
  }

  let models: { name: string; size?: number; }[] = [];
  try {
    models = await provider.listModels();
  } catch (err) {
    logger.debug(`listModels failed for ${provider.id}: ${ (err as Error).message}`);
    return [];
  }

  const probeLimit = process.env.OLLAMA_HOST && /ngrok|https:/i.test(process.env.OLLAMA_HOST) ? 8 : limit;
  const slice = models.slice(0, probeLimit);
  const concurrency = 4;
  const probed: import('./router.ts').Candidate[] = [];
  for (let i = 0; i < slice.length; i += concurrency) {
    const batch = slice.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (m) => {
        const candidate: import('./router.ts').Candidate = { name: m.name, sizeBytes: m.size };
        if (typeof provider.modelInfo === 'function') {
          try {
            const info = await provider.modelInfo(m.name);
            candidate.supportsTools = info?.supportsTools;
            candidate.contextLength = info?.contextLength;
            candidate.remote = info?.remote;
          } catch (err) {
            logger.debug(`modelInfo failed for ${m.name}: ${ (err as Error).message}`);
          }
        }
        return candidate;
      }),
    );
    probed.push(...results);
  }
  for (let i = probed.length; i < models.slice(0, limit).length; i++) {
    const m = models[i];
    probed.push({ name: m.name, sizeBytes: m.size });
  }

  catalogCache.set(provider.id, probed);
  return probed.map((c) => ({ ...c, resident: resident.has(c.name) }));
}

function memoryBudgetBytes(configured?: number | null): number | undefined {
  if (configured) return configured;
  const total = os.totalmem();
  if (!total) return undefined;
  return Math.floor(total * 0.45);
}

export async function autoSelectModel({ provider, model, workspace, policy = {}, toolsEnabled = true }: {
  provider: import('../types.ts').ProviderDef & { modelInfo?: (m: string) => Promise<any>; residentModels?: () => Promise<string[]>; };
  model: string;
  workspace?: { nativeTools?: boolean; contextLength?: number; remote?: boolean; };
  policy?: import('./router.ts').RoutingPolicy;
  toolsEnabled?: boolean;
}): Promise<{ model: string; reason: string; cost: 'free' | 'reload'; } | null> {
  if (policy.enabled === false) return null;

  const { chooseModel } = await import('./router.ts');

  const current = {
    name: model,
    supportsTools: workspace?.nativeTools,
    contextLength: workspace?.contextLength,
    remote: workspace?.remote,
    resident: true,
  };

  const candidates = await collectCandidates(provider);
  if (candidates.length <= 1) return null;

  return chooseModel({
    current,
    candidates: candidates.map((c) => (c.name === model ? { ...c, ...current } : c)),
    requirements: {
      needsTools: toolsEnabled,
      memoryBudgetBytes: memoryBudgetBytes(policy.maxModelBytes),
    },
    policy,
  });
}

