import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LANGUAGES, type Language } from '../languages';
import { probe } from './probe';
import type { InstallSpec, InstallStrategy } from '../../types';

const quoteArg = (a: string) => (/^[\w.@/-]+$/.test(a) ? a : JSON.stringify(a));
const onPath = (command: string) => async () => (await probe(command, ['--version'], 3000)) !== null;

// How each package manager installs a toolchain; a language's install recipe names these by id.
const STRATEGIES: readonly InstallStrategy[] = [
  {
    id: 'winget', label: 'winget', os: ['win32'], isAvailable: onPath('winget'),
    render(spec: InstallSpec) {
      const pkg = spec.packageId ?? spec.package;
      if (!pkg) throw new Error('winget install needs a packageId');
      return { command: `winget ${['install', '-e', '--id', pkg, '--accept-source-agreements', '--accept-package-agreements', '--silent'].map(quoteArg).join(' ')}` };
    },
  },
  {
    id: 'scoop', label: 'scoop', os: ['win32'], isAvailable: onPath('scoop'),
    render(spec: InstallSpec) {
      const pkg = spec.package ?? spec.packageId;
      if (!pkg) throw new Error('scoop install needs a package name');
      return { command: `scoop install ${pkg}` };
    },
  },
  {
    id: 'brew', label: 'Homebrew', os: ['darwin', 'linux'], isAvailable: onPath('brew'),
    render(spec: InstallSpec) {
      const formula = spec.formula ?? spec.package ?? spec.packageId;
      if (!formula) throw new Error('brew install needs a formula');
      return { command: `brew install${spec.cask ? ' --cask' : ''} ${formula}` };
    },
  },
  {
    id: 'apt', label: 'apt', os: ['linux'], isAvailable: onPath('apt-get'),
    render(spec: InstallSpec) {
      const pkg = spec.package ?? spec.packageId;
      if (!pkg) throw new Error('apt install needs a package name');
      return { command: `sudo apt-get install -y ${pkg}` };
    },
  },
  {
    id: 'rustup', label: 'rustup', os: ['win32', 'darwin', 'linux'], isAvailable: onPath('rustup'),
    render: (spec: InstallSpec) => ({ command: `rustup ${(spec.args?.length ? spec.args : ['toolchain', 'install', 'stable']).map(quoteArg).join(' ')}` }),
  },
  {
    id: 'fnm', label: 'fnm', os: ['win32', 'darwin', 'linux'], isAvailable: onPath('fnm'),
    render: (spec: InstallSpec) => ({ command: `fnm ${(spec.args?.length ? spec.args : ['install', '--lts']).map(quoteArg).join(' ')}` }),
  },
  {
    id: 'nvm', label: 'nvm', os: ['darwin', 'linux'],
    isAvailable: async () => fs.existsSync(path.join(process.env.NVM_DIR || path.join(os.homedir(), '.nvm'), 'nvm.sh')),
    render: (spec: InstallSpec) => ({
      command: `. "${process.env.NVM_DIR || path.join(os.homedir(), '.nvm')}/nvm.sh" && nvm install ${spec.args?.length ? spec.args[0] : '--lts'}`,
    }),
  },
];

export function getProviders(): Language[] {
  return [...LANGUAGES];
}

export function getProvider(id: string): Language | null {
  return LANGUAGES.find((l) => l.id === id) ?? null;
}

export function knownToolchainIds(): string[] {
  return LANGUAGES.map((l) => l.id);
}

function getStrategy(id: string): InstallStrategy | null {
  return STRATEGIES.find((s) => s.id === id) ?? null;
}

const availabilityCache = new Map<string, boolean>();

async function strategyAvailable(strategy: InstallStrategy): Promise<boolean> {
  const cached = availabilityCache.get(strategy.id);
  if (cached !== undefined) return cached;
  const ok = await strategy.isAvailable();
  availabilityCache.set(strategy.id, ok);
  return ok;
}

/** The first install recipe for this toolchain that works on this machine. */
export async function resolveStrategy(provider: Language, platform: string = process.platform): Promise<{ strategy: InstallStrategy; spec: InstallSpec } | null> {
  for (const spec of provider.install?.strategies ?? []) {
    const strategy = getStrategy(spec.strategy);
    if (!strategy || !strategy.os.includes(platform)) continue;
    if (await strategyAvailable(strategy)) return { strategy, spec };
  }
  return null;
}
