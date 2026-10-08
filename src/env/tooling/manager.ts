import path from 'node:path';

import { detectOne } from './probe';
import { getProvider, getProviders } from './registry';
import { readWindowsUserPath, applySessionPathRefresh } from './verifier';

interface ToolchainReportEntry {
  id: string;
  available: boolean;
  version?: string;
  command?: string;
}

/** Which of these toolchains are on PATH, for /doctor. Installing one is the model's or the person's job, in the shell. */
export async function checkToolchains(ids: string[]): Promise<{ toolchains: ToolchainReportEntry[] }> {
  const toolchains: ToolchainReportEntry[] = [];
  for (const id of ids) {
    const provider = getProvider(id);
    if (!provider) continue;
    const primary = provider.runtimes[0];
    const found = await detectOne(primary.name, primary.commands, primary.args ?? ['--version'], { searchPaths: provider.searchPaths });
    toolchains.push({ id: provider.id, available: found.available, version: found.version, command: found.command });
  }
  return { toolchains };
}

export async function refreshPathFromDetected(runtimes: Record<string, import('../../types.ts').RuntimeInfo>): Promise<string[]> {
  if (!Object.values(runtimes ?? {}).some((r) => r?.pathRefresh)) return [];
  const dirs: any[] = [];
  if (process.platform === 'win32') {
    const userPath = await readWindowsUserPath();
    if (userPath) dirs.push(...userPath.split(path.delimiter).filter(Boolean));
  }
  for (const provider of getProviders()) {
    for (const rt of provider.runtimes) {
      if (runtimes[rt.name]?.pathRefresh) {
        dirs.push(...(provider.searchPaths ?? []));
        break;
      }
    }
  }
  return applySessionPathRefresh(dirs);
}
