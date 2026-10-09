import type { FileScopedCommand } from '../types';

// What ocode knows about front-end frameworks inside a Node project. Data only: one more framework is one more row.

const ESLINT_SCRIPT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

/**
 * Framework files ESLint reads only through a plugin, by the package that adds it. Without the plugin ESLint skips such
 * a file with a warning, so it is linted only where the plugin is installed.
 */
const ESLINT_PLUGIN_EXTENSIONS: ReadonlyArray<{ plugin: string; extensions: string[] }> = [
  { plugin: 'eslint-plugin-vue', extensions: ['.vue'] },
  { plugin: 'eslint-plugin-svelte', extensions: ['.svelte'] },
  { plugin: 'eslint-plugin-astro', extensions: ['.astro'] },
  { plugin: 'angular-eslint', extensions: ['.html'] },
  { plugin: '@angular-eslint/eslint-plugin-template', extensions: ['.html'] },
];

/** ESLint run on given files, when the project has ESLint: its script extensions and its plugins' framework files. */
export function eslintFiles(pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }): FileScopedCommand | undefined {
  const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.eslint) return undefined;
  const extra = ESLINT_PLUGIN_EXTENSIONS.filter((p) => deps[p.plugin]).flatMap((p) => p.extensions);
  return { argv: ['npx', 'eslint'], extensions: [...new Set([...ESLINT_SCRIPT_EXTENSIONS, ...extra])] };
}

