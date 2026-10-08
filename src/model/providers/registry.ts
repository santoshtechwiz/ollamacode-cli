import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { validateProvider, looksLikeProvider } from './base';
import { ollamaProvider } from './ollama';
import { ollamaCloudProvider } from './ollama-cloud';
import { huggingfaceProvider } from './huggingface';
import { logger } from '../../core/logger';

const registry = new Map();

const ALIASES = new Map([
  ['hf', 'huggingface'],
  ['huggingface.co', 'huggingface'],
  ['local', 'ollama'],
  ['ollama_cloud', 'ollama-cloud'],
  ['ollamacloud', 'ollama-cloud'],
  ['cloud', 'ollama-cloud'],
]);

function registerProvider(provider: import('../../types.ts').ProviderDef, { override = false }: any = {}) {
  const valid = validateProvider(provider);
  if (registry.has(valid.id) && !override) {
    throw new Error(`Provider id already registered: ${valid.id}`);
  }
  registry.set(valid.id, valid);
  return valid;
}

export function getProviders(): import('../../types.ts').ProviderDef[] {
  return Array.from(registry.values());
}

export function getProvider(id: string): import('../../types.ts').ProviderDef | undefined {
  if (!id) return undefined;
  const key = String(id).trim().toLowerCase();
  return registry.get(key) ?? registry.get(ALIASES.get(key) ?? '');
}

export function resolveProviderId(id: string) {
  const key = String(id ?? '').trim().toLowerCase();
  return registry.has(key) ? key : ALIASES.get(key) ?? key;
}

export function knownProviderIds(): string[] {
  return [...registry.keys()];
}

let discovered = false;

export async function discoverUserProviders({ force = false }: any = {}) {
  if (discovered && !force) return;
  discovered = true;

  const { homeDir } = await import('../../core/config.ts');
  const dir = path.join(homeDir(), 'providers');

  let files: any[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.mjs'));
  } catch {
    return; // no plugin directory is the normal case
  }

  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const mod = await import(pathToFileURL(full).href);
      const candidates = new Set(
        [mod.default, ...Object.values(mod)].filter((c) => looksLikeProvider(c))
      );
      if (candidates.size === 0) {
        logger.debug(`provider plugin ${file}: no provider-shaped export`);
        continue;
      }
      for (const candidate of candidates) {
        try {
          registerProvider( (candidate as import('../../types.ts').ProviderDef), { override: true });
          logger.debug(`registered provider plugin: ${ (candidate as any).id}`);
        } catch (err) {
          logger.warn(`provider plugin ${file}: ${ (err as Error).message}`);
        }
      }
    } catch (err) {
      logger.warn(`skipped provider plugin ${file}: ${ (err as Error).message}`);
    }
  }
}

registerProvider(ollamaProvider);
registerProvider(ollamaCloudProvider);
registerProvider(huggingfaceProvider);

