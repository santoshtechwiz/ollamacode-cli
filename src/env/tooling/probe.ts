import fs from 'node:fs';
import path from 'node:path';
import { runChild } from '../process/index';

const PROBE_TIMEOUT_MS = 15_000;

const probeCache = new Map<string, import('../../types.ts').RuntimeInfo>();

type ProbeFn = (command: string, args?: string[], timeoutMs?: number, env?: NodeJS.ProcessEnv) => Promise<string | null>;

const injectedProbe: ProbeFn | null = null;

function resolveExecutable(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform !== 'win32' || path.isAbsolute(command)) return command;

  const exts = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = (env.PATH || '').split(path.delimiter).filter(Boolean);

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
      }
    }
  }
  return command;
}

function needsShell(file: string) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(file);
}

export async function probe(command: string, args: string[] = ['--version'], timeoutMs: number = PROBE_TIMEOUT_MS, env?: NodeJS.ProcessEnv): Promise<string | null> {
  if (injectedProbe) {
    return Promise.resolve(injectedProbe(command, args, timeoutMs, env)).then((v) => v ?? null);
  }
  const file = resolveExecutable(command, env);
  const out = await runChild({
    file,
    args,
    options: { env, shell: needsShell(file) } as import('node:child_process').SpawnOptions,
    timeoutMs,
  });
  if (out.spawnError || out.timedOut || out.cancelled) return null;
  if (out.exitCode !== 0) return null;
  const combined = `${out.stdout}\n${out.stderr}`.trim();
  if (!combined) return null;
  return combined.split('\n')[0].trim() || null;
}

export async function detectOne(name: string, candidates: string[] | ((platform: string) => string[]), args: string[] = ['--version'], { bypassCache = false, searchPaths = [] }: { bypassCache?: boolean; searchPaths?: string[]; } = {}): Promise<import('../../types.ts').RuntimeInfo> {
  if (!bypassCache) {
    const cached = probeCache.get(name);
    if (cached) return cached;
  }

  const list = typeof candidates === 'function' ? candidates(process.platform) : candidates;
  for (const command of list) {
    const version = await probe(command, args);
    if (version !== null) {
      const info = { name, available: true, version, command };
      probeCache.set(name, info);
      return info;
    }
  }

  for (const dir of searchPaths) {
    for (const command of list) {
      const env = { ...process.env, PATH: `${process.env.PATH ?? ''}${path.delimiter}${dir}` };
      const version = await probe(command, args, 5000, env);
      if (version !== null) {
        const info = {
          name,
          available: true,
          version,
          command: path.join(dir, command),
          pathRefresh: true, // on disk, just not on this session's PATH
        };
        probeCache.set(name, info);
        return info;
      }
    }
  }

  const info = { name, available: false };
  probeCache.set(name, info);
  return info;
}

export async function exists(file: string) {
  try {
    await fs.promises.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file: string) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function detectPackageManager(root: string): Promise<'npm' | 'pnpm' | 'yarn'> {
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

