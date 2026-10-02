import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { detectOne, probe } from './probe';

const execFileAsync = promisify(execFile);

function expandEnv(s: string) {
  return s.replace(/%([^%]+)%/g, (_, k) => process.env[k] ?? '');
}

export async function readWindowsUserPath(): Promise<string | null> {
  const keys = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  ];
  const parts: string[] = [];
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', 'Path'], {
        windowsHide: true,
        timeout: 5000,
      });
      const m = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/m);
      if (m?.[1]?.trim()) parts.push(m[1].trim());
    } catch {
    }
  }
  return parts.length ? parts.join(path.delimiter) : null;
}

export function applySessionPathRefresh(extraDirs: string[]): string[] {
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const seen = new Set(current.map((d) => d.toLowerCase()));
  const added: string[] = [];
  for (const dir of extraDirs) {
    const clean = String(dir ?? '').trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    current.push(clean);
    seen.add(clean.toLowerCase());
    added.push(clean);
  }
  if (added.length) process.env.PATH = current.join(path.delimiter);
  return added;
}

async function probeWithEnv(runtime: import('../../types.ts').ProviderRuntime, env: NodeJS.ProcessEnv): Promise<import('../../types.ts').RuntimeInfo | null> {
  const list = typeof runtime.commands === 'function' ? runtime.commands(process.platform) : runtime.commands;
  for (const cmd of list) {
    const version = await probe(cmd, runtime.args ?? ['--version'], 5000, env);
    if (version !== null) return { name: runtime.name, available: true, version, command: cmd };
  }
  return null;
}

export async function verifyToolchain(provider: import('../../types.ts').ToolchainProvider): Promise<Record<string, import('../../types.ts').RuntimeInfo & { pathRefresh?: boolean; }>> {
  const results: Record<string, import('../../types.ts').RuntimeInfo & { pathRefresh?: boolean; }> = {};
  for (const rt of provider.runtimes) {
    results[rt.name] = await detectOne(rt.name, rt.commands, rt.args ?? ['--version'], { bypassCache: true });
  }

  const primary = provider.runtimes[0];
  const entry = results[primary.name];
  if (!entry.available && process.platform === 'win32') {
    const userPath = await readWindowsUserPath();
    if (userPath) {
      const merged = {
        ...process.env,
        PATH: `${process.env.PATH ?? ''}${path.delimiter}${expandEnv(userPath)}`,
      };
      const fresh = await probeWithEnv(primary, merged);
      if (fresh) {
        entry.available = true;
        entry.version = fresh.version;
        entry.command = fresh.command;
        entry.pathRefresh = true;
      }
    }
  }
  return results;
}

