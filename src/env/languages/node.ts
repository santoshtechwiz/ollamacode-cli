import path from 'node:path';
import fs from 'node:fs/promises';
import { exists, readJson, detectPackageManager } from '../tooling/probe';
import { eslintFiles } from '../frameworks';
import type { StackInfo } from '../../types';
import type { Language } from './types';

/** OLLAMACODE.md naming mostly .js or mostly .ts files says which the project really is. */
async function languageFromProjectDoc(root: string): Promise<'js' | 'ts' | null> {
  const content = await fs.readFile(path.join(root, 'OLLAMACODE.md'), 'utf8').catch((): null => null);
  if (!content) return null;
  const names = [...content.matchAll(/`([\w./-]+\.(?:js|jsx|mjs|cjs|ts|tsx))`/g)].map((m) => m[1]);
  const js = names.filter((f) => /\.(?:js|jsx|mjs|cjs)$/i.test(f)).length;
  const ts = names.filter((f) => /\.(?:ts|tsx)$/i.test(f)).length;
  return js > ts ? 'js' : ts > js ? 'ts' : null;
}

async function detectNode(root: string): Promise<StackInfo | null> {
  const pkg = await readJson(path.join(root, 'package.json'));
  if (!pkg) return null;
  const pm = await detectPackageManager(root);
  const scripts = pkg.scripts ?? {};
  const script = (name: string) => (pm === 'npm' ? ['npm', 'run', name] : [pm, name]);
  const tsSignal = (await exists(path.join(root, 'tsconfig.json'))) || Boolean(pkg.devDependencies?.typescript || pkg.dependencies?.typescript);
  const usesTsc = Object.values(scripts).some((cmd) => /\btsc\b/.test(String(cmd)));
  const eslint = eslintFiles(pkg);
  const hasTs = !usesTsc && (await languageFromProjectDoc(root)) === 'js' ? false : tsSignal;
  return {
    id: 'node',
    label: hasTs ? 'TypeScript' : 'Node.js',
    typescript: hasTs,
    root,
    marker: 'package.json',
    test: scripts.test ? (pm === 'npm' ? ['npm', 'test'] : [pm, 'test']) : undefined,
    build: scripts.build ? script('build') : hasTs ? ['npx', 'tsc', '--noEmit'] : undefined,
    // Its own type check if it names one; else the compiler's, for TypeScript; plain JavaScript has no compile step.
    check: scripts.typecheck ? script('typecheck') : hasTs ? ['npx', 'tsc', '--noEmit'] : scripts.lint ? script('lint') : undefined,
    lint: scripts.lint ? script('lint') : undefined,
    fileScoped: eslint ? { lint: eslint } : undefined,
    run: scripts.dev ? script('dev') : scripts.start ? (pm === 'npm' ? ['npm', 'start'] : [pm, 'start']) : undefined,
    dev: scripts.dev ? script('dev') : undefined,
  };
}

export const NODE: Language = {
  id: 'node',
  label: 'Node.js',
  runtimes: [
    { name: 'node', commands: ['node'] },
    { name: 'npm', commands: ['npm'] },
    { name: 'pnpm', commands: ['pnpm'] },
    { name: 'yarn', commands: ['yarn'] },
    { name: 'tsc', commands: ['tsc'] },
  ],
  markers: ['package.json'],
  manifests: ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'],
  extensions: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'],
  detect: detectNode,
  source: {
    symbols: [
      /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s+(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*export\s+(?:const|let|var|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*class\s+([A-Za-z_$][\w$]*)/gm,
      /^\s*const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\(|\w[\w$]*\s*=>)/gm,
    ],
    imports: [
      /import\s+(?:[\w$]+|\{[^}]*\}|\*\s+as\s+[\w$]+)\s*,?\s*from\s+['"]([^'"]+)['"]/g,
      /import\s+['"]([^'"]+)['"]/g,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /export\s+[\w$*{},\s]+\s+from\s+['"]([^'"]+)['"]/g,
    ],
    exportRe: /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
  },
};
