import { TOOLCHAINS } from '../toolchains';
import type { ToolchainProvider } from '../../types';

export function getProviders(): ToolchainProvider[] {
  return [...TOOLCHAINS];
}

export function getProvider(id: string): ToolchainProvider | null {
  return TOOLCHAINS.find((p) => p.id === id) ?? null;
}
