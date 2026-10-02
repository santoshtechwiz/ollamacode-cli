import path from 'node:path';

import { detectOne } from './probe';
import { detectRuntimes, detectStacks, missingToolHint } from './detector';
import { getProvider, getProviders, knownToolchainIds, resolveStrategy } from './registry';
import { installToolchain } from './installer';
import { verifyToolchain, readWindowsUserPath, applySessionPathRefresh } from './verifier';

export interface ToolchainReportEntry {
  id: string;
  label: string;
  known: boolean;
  available: boolean;
  version?: string;
  command?: string;
  needed?: boolean;
  installable?: boolean;
  installed?: boolean;
  strategy?: string;
  verified?: boolean;
  pathRefresh?: boolean;
  pathRefreshed?: boolean;
  pathAdded?: string[];
  error?: string;
  code?: string;
  output?: string;
}

export interface ToolchainReport {
  toolchains: ToolchainReportEntry[];
  ok: boolean;
}

export type ToolingManager = ReturnType<typeof createToolingManager>;

async function refreshSessionPath(provider: import('../../types.ts').ToolchainProvider): Promise<string[]> {
  const dirs: any[] = [];
  if (process.platform === 'win32') {
    const userPath = await readWindowsUserPath();
    if (userPath) dirs.push(...userPath.split(path.delimiter).filter(Boolean));
  }
  dirs.push(...(provider.searchPaths ?? []));
  return applySessionPathRefresh(dirs);
}

async function detectProvider(provider: import('../../types.ts').ToolchainProvider) {
  const primary = provider.runtimes[0];
  return detectOne(primary.name, primary.commands, primary.args ?? ['--version'], {
    searchPaths: provider.searchPaths,
  });
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

async function ensureToolchains(ids: string[], { install = false, cwd, signal }: any = {}): Promise<ToolchainReport> {
  const toolchains: any[] = [];

  for (const rawId of ids) {
    const id = String(rawId ?? '').trim().toLowerCase();
    const provider = getProvider(id);
    if (!provider) {
      toolchains.push({
        id,
        label: id,
        known: false,
        available: false,
        error: `Unknown toolchain "${id}". Known: ${knownToolchainIds().join(', ')}`,
        code: 'EUNKNOWN',
      });
      continue;
    }

    const before = await detectProvider(provider);
    const base: {
      id: string;
      label: string;
      known: boolean;
      available: boolean;
      version?: string;
      command?: string;
      pathRefresh: boolean;
      pathRefreshed?: boolean;
      pathAdded?: string[];
    } = {
      id: provider.id,
      label: provider.label,
      known: true,
      available: before.available,
      version: before.version,
      command: before.command,
      pathRefresh: before.pathRefresh === true,
    };

    if (before.available) {
      if (before.pathRefresh === true) {
        const added = await refreshSessionPath(provider);
        if (added.length) {
          base.pathRefreshed = true;
          base.pathAdded = added;
        }
      }
      toolchains.push(base);
      continue;
    }

    if (!install) {
      toolchains.push({
        ...base,
        needed: true,
        installable: Boolean(provider.install?.strategies?.length),
      });
      continue;
    }

    const resolved = await resolveStrategy(provider);
    if (!resolved) {
      toolchains.push({
        ...base,
        error: provider.install?.hint ?? `No supported installation strategy for ${provider.label} on this platform.`,
        code: ('ENOTSUPPORTED' as import('../../protocol.ts').ToolErrorCode),
      });
      continue;
    }

    const outcome = await installToolchain({
      strategy: resolved.strategy,
      spec: resolved.spec,
      cwd,
      signal,
    });
    if (!outcome.ok) {
      const tail = `${outcome.stdout ?? ''}\n${outcome.stderr ?? ''}`.trim();
      toolchains.push({
        ...base,
        error:
          outcome.error ??
          `Install failed (${resolved.strategy.label})${tail ? `: ${tail.split('\n').pop()}` : ''}`,
        code: (outcome.code ?? 'EEXIT' as import('../../protocol.ts').ToolErrorCode),
        installed: true,
        strategy: resolved.strategy.label,
        output: tail.slice(0, 400),
      });
      continue;
    }

    const verified = await verifyToolchain(provider);
    const primary = provider.runtimes[0];
    const v = verified[primary.name] ?? before;
    const pathRefresh = (v as any).pathRefresh === true;
    const pathAdded = pathRefresh ? await refreshSessionPath(provider) : [];
    toolchains.push({
      ...base,
      available: v.available,
      version: v.version ?? before.version,
      command: v.command ?? before.command,
      installed: true,
      strategy: resolved.strategy.label,
      verified: v.available,
      pathRefresh,
      ...(pathAdded.length ? { pathRefreshed: true, pathAdded } : {}),
      ...(v.available
        ? {}
        : {
            error: `Installer finished but ${primary.name} is still not on PATH. The install may be partial; check the package manager's output.`,
            code: ('ENOTVERIFIED' as import('../../protocol.ts').ToolErrorCode),
          }),
    });
  }

  return { toolchains, ok: toolchains.every((t) => t.available) };
}

async function checkToolchains(ids: string[]): Promise<ToolchainReport> {
  return ensureToolchains(ids, { install: false });
}

function renderReport(report: ToolchainReport): string {
  return report.toolchains
    .map((t) => {
      if (!t.known) return `- ${t.id}: unknown (${t.error})`;
      if (t.available && t.pathRefreshed) {
        return (
          `- ${t.id}: installed (${t.version ?? ''}) — PATH refreshed for this session, so it works now; ` +
          `in your own terminal run refreshenv (or restart it) before typing commands yourself`
        );
      }
      if (t.available && t.pathRefresh) {
        return `- ${t.id}: installed (${t.version ?? ''}) — visible in a new shell; restart the session to use it`;
      }
      if (t.available) return `- ${t.id}: available${t.version ? ` (${t.version})` : ''}${t.installed ? ` via ${t.strategy}` : ''}`;
      if (t.installed && t.verified === false) return `- ${t.id}: INSTALLED but NOT on PATH — ${t.error}`;
      if (t.installed) return `- ${t.id}: install failed (${t.strategy}) — ${t.error}`;
      if (t.needed) {
        return t.installable
          ? `- ${t.id}: MISSING — install with ensure_toolchain {toolchains:["${t.id}"], install:true}`
          : `- ${t.id}: MISSING — no install strategy: ${t.error}`;
      }
      return `- ${t.id}: ${t.error ?? 'unknown status'}`;
    })
    .join('\n');
}

export function createToolingManager() {
  return {
    check: checkToolchains,
    ensure: ensureToolchains,
    render: renderReport,
    detectRuntimes,
    detectStacks,
    missingToolHint,
  };
}

