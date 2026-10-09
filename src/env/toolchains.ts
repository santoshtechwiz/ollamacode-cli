import { LANGUAGES } from './languages';
import type { ToolchainProvider } from '../types';

// Everything whose runtime ocode looks for on the machine: the languages, and tools that belong to no kind of project.

/** Git: found and reported like a language's runtime, but no project is a git project. */
export const GIT: ToolchainProvider = {
  id: 'git',
  label: 'Git',
  runtimes: [{ name: 'git', commands: ['git'] }],
};

/** Tools any workspace may use, whatever its projects. One more is one more entry. */
export const TOOLS: readonly ToolchainProvider[] = [GIT];

export const TOOLCHAINS: readonly ToolchainProvider[] = [...LANGUAGES, ...TOOLS];
