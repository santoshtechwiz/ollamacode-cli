import path from 'node:path';
import { exists, readJson, detectPackageManager } from '../tooling/probe';
import { eslintFiles, frameworksOf } from '../frameworks';
import fs from 'node:fs';
import type { StackInfo, TsconfigScope } from '../../types';
import type { Language } from './types';

/**
 * A command a package installs, run with node from the project's own node_modules: `node node_modules/typescript/bin/tsc`.
 * npx finds the same file, but it starts a node of its own to look for it first, which costs seconds per check on
 * Windows. npx stays the fallback when the package is not installed here.
 */
async function localBin(root: string, pkgName: string, binName: string): Promise<string[]> {
  const pkgDir = path.join(root, 'node_modules', pkgName);
  const manifest = await readJson(path.join(pkgDir, 'package.json'));
  const bin = typeof manifest?.bin === 'string' ? manifest.bin : manifest?.bin?.[binName];
  if (typeof bin === 'string' && (await exists(path.join(pkgDir, bin)))) {
    return ['node', path.posix.join('node_modules', pkgName, bin.split(path.sep).join('/'))];
  }
  return ['npx', binName];
}

/** JSON with the comments and trailing commas tsconfig allows; null when it does not parse. */
function readJsonc(file: string): any {
  try {
    const text = fs.readFileSync(file, 'utf8')
      // Strings first, so a "//" inside one ("paths": {"@/*": ...}) is kept; then comments and trailing commas.
      .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** tsc's own defaults for a tsconfig that lists no exclude. */
const DEFAULT_EXCLUDE = ['node_modules', 'bower_components', 'jspm_packages'];

/**
 * The files a type check reads, from the tsconfig it runs with: the project's tsconfig.json, or the one its typecheck
 * script names with -p. Undefined whenever that cannot be told from the file alone (a check that is not tsc, a build
 * mode or project references, settings inherited through extends): the check then runs for any source change, as before.
 */
function typecheckScope(root: string, command: string | undefined): TsconfigScope | undefined {
  if (!command || !/\btsc\b/.test(command) || /(^|\s)(-b|--build)(\s|$)/.test(command)) return undefined;
  const projects = [...command.matchAll(/(?:^|\s)(?:-p|--project)\s+("[^"]+"|\S+)/g)].map((m) => m[1].replace(/^"|"$/g, ''));
  if (projects.length > 1) return undefined;
  let file = path.resolve(root, projects[0] ?? 'tsconfig.json');
  if (!file.endsWith('.json')) file = path.join(file, 'tsconfig.json');
  const config = readJsonc(file);
  if (!config || typeof config !== 'object' || config.references) return undefined;
  const options = config.compilerOptions ?? {};
  const lists = (key: string) => (Array.isArray(config[key]) ? config[key].map(String) : undefined);
  const [files, include, exclude] = [lists('files'), lists('include'), lists('exclude')];
  // What a base config would add is not read here.
  if (config.extends && ((!files && !include) || options.allowJs === undefined)) return undefined;
  return {
    base: path.relative(root, path.dirname(file)).split(path.sep).join('/'),
    files: files ?? [],
    include: include ?? (files ? [] : ['**/*']),
    exclude: exclude ?? [...DEFAULT_EXCLUDE, ...(typeof options.outDir === 'string' ? [options.outDir] : [])],
    allowJs: options.allowJs === true,
  };
}

async function detectNode(root: string): Promise<StackInfo | null> {
  const pkg = await readJson(path.join(root, 'package.json'));
  if (!pkg) return null;
  const pm = await detectPackageManager(root);
  const scripts = pkg.scripts ?? {};
  const script = (name: string) => (pm === 'npm' ? ['npm', 'run', name] : [pm, name]);
  // Written in TypeScript: it has a tsconfig.json, or its scripts run tsc. A typescript dependency alone is not enough:
  // JavaScript projects pull it in for editor types, and tsc --noEmit over them checks nothing they wrote.
  const usesTsc = Object.values(scripts).some((cmd) => /\btsc\b/.test(String(cmd)));
  const hasTs = usesTsc || (await exists(path.join(root, 'tsconfig.json')));
  // A tsconfig that only points at others (Vite's: "files": [] and references) gives plain tsc nothing to read: it
  // exited 0 over a file full of type errors. Build mode checks each referenced project; --noEmit keeps it from writing.
  const references = readJsonc(path.join(root, 'tsconfig.json'))?.references;
  const tsc = [...(await localBin(root, 'typescript', 'tsc')), ...(Array.isArray(references) && references.length ? ['-b'] : []), '--noEmit'];
  const eslint = eslintFiles(pkg, await localBin(root, 'eslint', 'eslint'));
  const checkCommand = scripts.typecheck ? String(scripts.typecheck) : hasTs ? 'tsc --noEmit' : undefined;
  return {
    id: 'node',
    label: hasTs ? 'TypeScript' : 'Node.js',
    typescript: hasTs,
    frameworks: frameworksOf(pkg).map((f) => f.label),
    root,
    marker: 'package.json',
    test: scripts.test ? (pm === 'npm' ? ['npm', 'test'] : [pm, 'test']) : undefined,
    build: scripts.build ? script('build') : hasTs ? tsc : undefined,
    // Its own type check if it names one; else the compiler's, for TypeScript; plain JavaScript has no compile step.
    check: scripts.typecheck ? script('typecheck') : hasTs ? tsc : scripts.lint ? script('lint') : undefined,
    lint: scripts.lint ? script('lint') : undefined,
    fileScoped: eslint ? { lint: eslint } : undefined,
    checkReads: typecheckScope(root, checkCommand),
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
