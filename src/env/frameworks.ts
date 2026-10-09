import type { FileScopedCommand } from '../types';

// What ocode knows about front-end frameworks inside a Node project. Data only: one more framework is one more row.

export interface Framework {
  id: string;
  label: string;
  /** Any of these packages among the project's dependencies means it uses this framework. */
  packages: readonly string[];
  /** Frameworks this one is built on, so a Next.js project reads as Next.js, not Next.js and React. */
  builtOn?: readonly string[];
  /** ESLint plugins that let ESLint read this framework's own files, and the extensions of those files. */
  eslint?: { plugins: readonly string[]; extensions: readonly string[] };
}

export const FRAMEWORKS: readonly Framework[] = [
  { id: 'next', label: 'Next.js', packages: ['next'], builtOn: ['react'] },
  { id: 'remix', label: 'Remix', packages: ['@remix-run/react'], builtOn: ['react'] },
  { id: 'react', label: 'React', packages: ['react'] },
  { id: 'nuxt', label: 'Nuxt', packages: ['nuxt'], builtOn: ['vue'] },
  { id: 'vue', label: 'Vue', packages: ['vue'], eslint: { plugins: ['eslint-plugin-vue'], extensions: ['.vue'] } },
  { id: 'angular', label: 'Angular', packages: ['@angular/core'], eslint: { plugins: ['angular-eslint', '@angular-eslint/eslint-plugin-template'], extensions: ['.html'] } },
  { id: 'sveltekit', label: 'SvelteKit', packages: ['@sveltejs/kit'], builtOn: ['svelte'] },
  { id: 'svelte', label: 'Svelte', packages: ['svelte'], eslint: { plugins: ['eslint-plugin-svelte'], extensions: ['.svelte'] } },
  { id: 'astro', label: 'Astro', packages: ['astro'], eslint: { plugins: ['eslint-plugin-astro'], extensions: ['.astro'] } },
];

type PackageJson = { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

const dependenciesOf = (pkg: PackageJson): Record<string, string> => ({ ...pkg.dependencies, ...pkg.devDependencies });

/** The frameworks a project uses, most specific first: one another is built on is left out. */
export function frameworksOf(pkg: PackageJson): Framework[] {
  const deps = dependenciesOf(pkg);
  const used = FRAMEWORKS.filter((f) => f.packages.some((p) => deps[p]));
  const under = new Set(used.flatMap((f) => f.builtOn ?? []));
  return used.filter((f) => !under.has(f.id));
}

const ESLINT_SCRIPT_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];

/**
 * ESLint run on given files (`run` is how to start it), when the project has ESLint: script files, and a framework's own files when its ESLint
 * plugin is installed (without the plugin ESLint skips such a file with a warning).
 */
export function eslintFiles(pkg: PackageJson, run: string[] = ['npx', 'eslint']): FileScopedCommand | undefined {
  const deps = dependenciesOf(pkg);
  if (!deps.eslint) return undefined;
  const extra = FRAMEWORKS.flatMap((f) => (f.eslint?.plugins.some((p) => deps[p]) ? f.eslint.extensions : []));
  return { argv: run, extensions: [...new Set([...ESLINT_SCRIPT_EXTENSIONS, ...extra])] };
}
