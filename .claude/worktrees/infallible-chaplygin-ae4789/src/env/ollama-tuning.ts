import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { REASONING_RESERVE_FRACTION } from '../protocol';

const execFileAsync = promisify(execFile);

const TUNED_ENV = Object.freeze({
  OLLAMA_IGPU_ENABLE: '1',
  OLLAMA_KV_CACHE_TYPE: 'q8_0',
  OLLAMA_CONTEXT_LENGTH: '16384',
  OLLAMA_KEEP_ALIVE: '10m',
  OLLAMA_MAX_LOADED_MODELS: '1',
});

const LOW_DISK_BYTES = 15 * 1024 ** 3;

function ollamaModelsDir(): string {
  return process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
}

function partialBlobs(dir: string = ollamaModelsDir()): { files: string[]; bytes: number; } {
  const blobs = path.join(dir, 'blobs');
  const files: any[] = [];
  let bytes = 0;
  let entries;
  try {
    entries = fs.readdirSync(blobs);
  } catch {
    return { files, bytes };
  }
  for (const name of entries) {
    if (!name.includes('-partial')) continue;
    try {
      bytes += fs.statSync(path.join(blobs, name)).size;
      files.push(name);
    } catch {
    }
  }
  return { files, bytes };
}

function freeBytes(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}

function gb(n: number) {
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

async function persistUserEnv(name: string, value: string) {
  if (process.platform !== 'win32') return false;
  await execFileAsync('setx', [name, value], { windowsHide: true });
  process.env[name] = value; // so a second check in the same run agrees
  return true;
}

export function envDriftCheck(): import('../cli/commands/doctor.ts').Check {
  const drifted: any[] = [];
  for (const [name, want] of Object.entries(TUNED_ENV)) {
    const got = process.env[name];
    if (got !== want) drifted.push(`${name}=${got ?? '(unset)'} → ${want}`);
  }

  if (drifted.length === 0) {
    return { name: 'ollama-env', status: 'ok', message: 'tuned environment is applied' };
  }

  return {
    name: 'ollama-env',
    status: 'warn',
    message: `${drifted.length} tuned variable(s) drifted: ${drifted.join(', ')}`,
    fix: async () => {
      let wrote = 0;
      for (const [name, want] of Object.entries(TUNED_ENV)) {
        if (process.env[name] === want) continue;
        if (await persistUserEnv(name, want)) wrote++;
      }
      return wrote > 0;
    },
  };
}

export function diskCheck(): import('../cli/commands/doctor.ts').Check {
  const dir = ollamaModelsDir();
  const { files, bytes } = partialBlobs(dir);
  const free = freeBytes(dir);
  const lowDisk = free !== null && free < LOW_DISK_BYTES;

  if (files.length === 0 && !lowDisk) {
    return {
      name: 'ollama-disk',
      status: 'ok',
      message: free === null ? 'no interrupted pulls' : `no interrupted pulls, ${gb(free)} free`,
    };
  }

  const parts: any[] = [];
  if (files.length > 0) parts.push(`${files.length} partial blob(s) holding ${gb(bytes)}`);
  if (lowDisk && free !== null) parts.push(`only ${gb(free)} free`);

  return {
    name: 'ollama-disk',
    status: 'warn',
    message: `${parts.join('; ')} — remove *-partial* in ${path.join(dir, 'blobs')} once no pull is active`,
  };
}

/** Is there room to send a prompt at all? The reply reserve (`maxTokens`) comes out of the window before the prompt does, so an over-large one starves it. */
export function contextFitCheck(
  cfg: { agent?: { contextBudget?: number; contextWindow?: number; maxTokens?: number; }; },
  updateConfig: (mutate: (c: any) => void) => void
): import('../cli/commands/doctor.ts').Check | null {
  const window = cfg.agent?.contextWindow;
  const reserve = cfg.agent?.maxTokens;
  if (typeof window !== 'number' || typeof reserve !== 'number') return null;

  const promptRoom = window - reserve;
  // Same ceiling the session budget applies when it picks a reply reserve.
  const maxReserve = Math.floor(window * REASONING_RESERVE_FRACTION);

  if (reserve <= maxReserve && promptRoom > 0) {
    return {
      name: 'context-fit',
      status: 'ok',
      message: `${promptRoom} tokens for the prompt (${window} window, ${reserve} reserved for the reply)`,
    };
  }

  const suggested = Math.max(1, maxReserve);
  return {
    name: 'context-fit',
    status: 'warn',
    message:
      `agent.maxTokens is ${reserve} of a ${window} window, leaving ${promptRoom} for the prompt — ` +
      'the reply reserve is taken out before the prompt is built',
    fix: async () => {
      updateConfig((c) => {
        c.agent.maxTokens = suggested;
      });
      return true;
    },
  };
}

export async function modelToolsCheck(model: string, provider: any): Promise<import('../cli/commands/doctor.ts').Check | null> {
  if (typeof provider?.modelInfo !== 'function') return null;
  try {
    const info = await provider.modelInfo(model);
    if (info?.supportsTools) {
      return { name: 'model-tools', status: 'ok', message: `${model} supports native tool calling` };
    }
    return {
      name: 'model-tools',
      status: 'warn',
      message: `${model} has no tool template — ocode falls back to text-mode tool calls`,
    };
  } catch {
    return null;
  }
}

