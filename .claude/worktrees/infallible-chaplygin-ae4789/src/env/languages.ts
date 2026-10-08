import path from 'node:path';
import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import os from 'node:os';

import { exists, readJson, detectPackageManager } from './tooling/probe';
import { isEditableSource } from './diagnostics/paths';
import type { Diagnostic, StackInfo, ToolchainProvider } from '../types';

// Every language ocode knows, in one table: to support a new one, add an entry here and nothing else.

/** Project commands built from the runtime command that was found (e.g. `python` or `py`) and the marker that identified the project. */
type Command = (cmd: string, marker: string) => string[] | undefined;
type Commands = { test?: Command; build?: Command; lint?: Command; run?: Command };

export interface Language extends ToolchainProvider {
  /** Files whose presence marks a project root. */
  markers?: string[];
  /** Marker names that vary per project, like `App.csproj`. */
  markerPattern?: RegExp;
  /** Dependency files besides the markers whose change means the project's packages changed. */
  manifests?: string[];
  /** Source file extensions; a project with no marker is still found by these. */
  extensions?: string[];
  commands?: Commands;
  /** Custom project detection when markers and commands are not enough. */
  detect?: (root: string) => Promise<StackInfo | null>;
  /** Commands whose output this language's parser understands, whatever the detected stack. */
  commandPattern?: RegExp;
  /** Other stack ids whose output this parser also reads. */
  stackAliases?: string[];
  /** Folders a build writes inside the project (`bin/`, `obj/`): generated, never the project's own source. */
  outputDirs?: string[];
  /** Turns tool output into file/line diagnostics. */
  parse?: (output: string) => Diagnostic[];
  /** Patterns the workspace index uses to find symbols and imports in source files. */
  source?: { symbols: RegExp[]; imports: RegExp[]; exportRe?: RegExp };
}

// Parser helpers shared by several languages.

function dedupe(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.file}:${d.line ?? ''}:${d.code ?? ''}:${d.symbol ?? ''}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The first quoted token in compiler prose: `'ProductManager' could not be found`, `No module named 'bar'`. */
function quotedName(text: string): string | null {
  const m = /['"`]([^'"`\n]{1,120})['"`]/.exec(String(text ?? ''));
  return m?.[1]?.trim() || null;
}

/** Tag a diagnostic as referenced-but-undefined when its code says so. */
function tagMissingByCode(diag: { code?: string; message?: string; kind?: string; symbol?: string }, codes: ReadonlySet<string>): void {
  if (!diag.code || !codes.has(String(diag.code).toUpperCase())) return;
  diag.kind = 'missing';
  diag.symbol = quotedName(String(diag.message ?? '')) ?? '';
}

function scan(output: string, re: RegExp, build: (m: RegExpExecArray) => any): any[] {
  const out: any[] = [];
  for (let m = re.exec(output); m !== null; m = re.exec(output)) {
    const d = build(m);
    if (d) out.push(d);
  }
  return out;
}

// JavaScript / TypeScript

const TS_MISSING = new Set(['TS2304', 'TS2307', 'TS2339']);

function parseTypeScript(output: string): Diagnostic[] {
  const out: any[] = [];
  for (const re of [
    /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s*(.+)$/gm,
    /^(.+?):(\d+):(\d+)\s+-\s+(error|warning)\s+(TS\d+):\s*(.+)$/gm,
  ]) {
    out.push(...scan(output, re, (m) => {
      const diag = { file: m[1].trim(), line: Number(m[2]), column: Number(m[3]), severity: m[4], code: m[5], message: m[6].trim() };
      tagMissingByCode(diag, TS_MISSING);
      return diag;
    }));
  }
  return out;
}

function tagMissingModules(out: any[]): any[] {
  for (const d of out) {
    const m = /Cannot find module '([^']+)'/i.exec(String(d?.message ?? ''));
    if (!m) continue;
    d.kind = 'missing';
    d.symbol = m[1];
  }
  return out;
}

function firstSourceFrame(block: string): { file: string; line: number; column: number } | null {
  const frame = /(?:at\s+.*?\(|[❯>]\s+)?((?:[A-Za-z]:[\\/]|\.{0,2}[\\/])?[\w.@$-]+(?:[\\/][\w.@$-]+)*\.[cm]?[jt]sx?):(\d+):(\d+)/g;
  for (let m = frame.exec(block); m !== null; m = frame.exec(block)) {
    if (!isEditableSource(m[1])) continue;
    return { file: m[1], line: Number(m[2]), column: Number(m[3]) };
  }
  return null;
}

function parseNodeTest(output: string): Diagnostic[] {
  const out = scan(output, /^\s*not ok \d+ - (.+)$/gm, (m) => {
    const name = m[1].trim();
    // A file-level rollup, not a test.
    if (name.startsWith('/') || /^[A-Za-z]:\\/.test(name)) return null;
    return { file: '(test)', severity: 'failure', message: name };
  });
  const locations = scan(output, /location:\s*'([^']+):(\d+):(\d+)'/g, (m) => ({ file: m[1], line: Number(m[2]), column: Number(m[3]) }));
  for (let i = 0; i < out.length && i < locations.length; i++) Object.assign(out[i], locations[i]);
  return tagMissingModules(out);
}

function parseJest(output: string): Diagnostic[] {
  const out: any[] = [];
  for (const part of output.split(/^\s*●\s+/m).slice(1)) {
    const name = part.split('\n')[0].trim();
    if (!name || /^Console$/i.test(name)) continue;
    const frame = firstSourceFrame(part);
    out.push({ file: frame?.file ?? '(test)', line: frame?.line, column: frame?.column, severity: 'failure', message: name });
  }
  return dedupe(tagMissingModules(out));
}

function parseVitest(output: string): Diagnostic[] {
  const out = scan(output, /^\s*FAIL\s+(\S+?)\s*>\s*(.+?)\s*$/gm, (m) => {
    const file = m[1].trim();
    if (!isEditableSource(file)) return null;
    const frame = firstSourceFrame(output.slice(m.index).slice(0, 800));
    const here = frame && frame.file === file;
    return { file, line: here ? frame.line : undefined, column: here ? frame.column : undefined, severity: 'failure', message: m[2].trim() };
  });
  return dedupe(tagMissingModules(out));
}

const MOCHA_FAILURE_TEXT = /^\s*(?:[A-Z]\w*Error\b|Error:|AssertionError\b|expected .+ to |\+ expected|- actual)/m;

function parseMocha(output: string): Diagnostic[] {
  const out: any[] = [];
  for (const part of output.split(/^\s*\d+\)\s+/m).slice(1)) {
    const head = part.split('\n').slice(0, 2).map((l) => l.trim()).filter(Boolean).join(' ').replace(/:$/, '');
    if (!head) continue;
    const frame = firstSourceFrame(part);
    if (!frame && !MOCHA_FAILURE_TEXT.test(part)) continue;
    out.push({ file: frame?.file ?? '(test)', line: frame?.line, column: frame?.column, severity: 'failure', message: head });
  }
  return dedupe(tagMissingModules(out));
}

function tagMissingRuntime(diag: { code?: string; message?: string; kind?: string; symbol?: string }): void {
  const code = String(diag.code ?? '');
  const message = String(diag.message ?? '');
  if (code === 'ReferenceError') {
    const m = /(\S+) is not defined/i.exec(message);
    if (!m) return;
    diag.kind = 'missing';
    diag.symbol = m[1];
  } else if (code === 'ERR_MODULE_NOT_FOUND') {
    diag.kind = 'missing';
    diag.symbol = quotedName(message) ?? '';
  }
}

function parseNodeRuntime(output: string): Diagnostic[] {
  const out = scan(output, /^(\/|[A-Za-z]:\\|file:\/\/)?([^\s:()]+\.(?:m?[jt]s|cjs)):(\d+)$/gm, (m) => ({ file: m[2], line: Number(m[3]), severity: 'error', message: 'runtime error' }));
  const errorLine = output.match(/^([A-Z]\w*(?:Error|Exception)):\s*(.+)$/m);
  const frames = scan(output, /at .*?\(?(?:file:\/\/\/)?([A-Za-z]:[\\/][^\s:()]+|\/[^\s:()]+|[^\s:()]+\.[cm]?[jt]s):(\d+):(\d+)\)?/g, (m) =>
    m[1].includes('node:internal') ? null : { file: m[1], line: Number(m[2]), column: Number(m[3]) });
  if (errorLine && frames.length > 0) {
    const diag = { ...frames[0], severity: 'error', code: errorLine[1], message: errorLine[2].trim() };
    tagMissingRuntime(diag);
    out.push(diag);
  } else if (errorLine && out.length > 0) {
    out[0].code = errorLine[1];
    out[0].message = errorLine[2].trim();
    tagMissingRuntime(out[0]);
  }
  return out;
}

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
  const hasTs = !usesTsc && (await languageFromProjectDoc(root)) === 'js' ? false : tsSignal;
  return {
    id: hasTs ? 'typescript' : 'node',
    label: hasTs ? 'TypeScript' : 'Node.js',
    root,
    marker: 'package.json',
    test: scripts.test ? (pm === 'npm' ? ['npm', 'test'] : [pm, 'test']) : undefined,
    build: scripts.build ? script('build') : hasTs ? ['npx', 'tsc', '--noEmit'] : undefined,
    lint: scripts.lint ? script('lint') : undefined,
    run: scripts.dev ? script('dev') : scripts.start ? (pm === 'npm' ? ['npm', 'start'] : [pm, 'start']) : undefined,
    dev: scripts.dev ? script('dev') : undefined,
  };
}

// Python

const PY_MISSING = /^(NameError|ModuleNotFoundError|ImportError)\b/;

function parsePytest(output: string): Diagnostic[] {
  const out = scan(output, /^(.*?\.py):(\d+):\s+(.+)$/gm, (m) => {
    const diag: any = { file: m[1].trim(), line: Number(m[2]), severity: 'failure', message: m[3].trim() };
    if (PY_MISSING.test(diag.message)) {
      diag.kind = 'missing';
      diag.symbol = /name '(\w+)' is not defined/i.exec(diag.message)?.[1] ?? quotedName(diag.message) ?? '';
    }
    return diag;
  });
  out.push(...scan(output, /^FAILED\s+(.+?)::(\S+)(?:\s+-\s+(.*))?$/gm, (m) => ({
    file: m[1].trim(), severity: 'failure', message: `${m[2]}${m[3] ? `: ${m[3].trim()}` : ' failed'}`,
  })));
  out.push(...scan(output, /File "([^"]+)", line (\d+)/g, (m) => ({ file: m[1], line: Number(m[2]), severity: 'error', message: 'syntax or import error' })));
  return dedupe(out);
}

// .NET

const DOTNET_MISSING = new Set(['CS0246', 'CS0103', 'CS0234']);
const DOTNET_PROJECT = /\.(sln|slnx|csproj|fsproj|vbproj)$/i;
const MAX_SIBLINGS_FOR_NESTED_DOTNET_SCAN = 8;

function parseDotnet(output: string): Diagnostic[] {
  const out = scan(output, /^\s*(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s*(.+?)(?:\s+\[([^\]]*)\])?$/gm, (m) => {
    const diag = { file: m[1].trim(), line: Number(m[2]), column: Number(m[3]), severity: m[4], code: m[5], message: m[6].trim(), project: m[7]?.trim() || undefined };
    tagMissingByCode(diag, DOTNET_MISSING);
    return diag;
  });
  out.push(...scan(output, /^\s*(?:Failed|X)\s+(\S+)(?:\s+\[.*\])?$/gm, (m) => ({ file: '(test)', severity: 'failure', message: `${m[1]} failed` })));
  return dedupe(out);
}

async function detectDotnet(root: string): Promise<StackInfo | null> {
  const project = await findDotnetProject(root);
  if (!project) return null;
  return { id: 'dotnet', label: 'C# / .NET', root, marker: path.basename(project), test: ['dotnet', 'test'], build: ['dotnet', 'build'], run: ['dotnet', 'run'] };
}

async function findDotnetProject(root: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const direct = entries.find((e) => e.isFile() && /\.(sln|slnx|csproj|fsproj)$/i.test(e.name));
    if (direct) return path.join(root, direct.name);
    const subdirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', 'bin', 'obj'].includes(e.name));
    if (subdirs.length > MAX_SIBLINGS_FOR_NESTED_DOTNET_SCAN) return null;
    for (const entry of subdirs) {
      const nested = await fs.readdir(path.join(root, entry.name), { withFileTypes: true }).catch((): import('node:fs').Dirent[] => []);
      const hit = nested.find((e) => e.isFile() && /\.(csproj|fsproj)$/i.test(e.name));
      if (hit) return path.join(root, entry.name, hit.name);
    }
  } catch { /* unreadable root: not a .NET project */ }
  return null;
}

// Rust

function parseCargo(output: string): Diagnostic[] {
  const out = scan(output, /^(error|warning)(?:\[(E\d+)\])?:\s*(.+)\n\s*-->\s*(.+?):(\d+):(\d+)/gm, (m) => ({
    file: m[4].trim(), line: Number(m[5]), column: Number(m[6]), severity: m[1], code: m[2], message: m[3].trim(),
  }));
  out.push(...scan(output, /^thread '([^']+)'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):?\n(.*)$/gm, (m) => ({
    file: m[2].trim(), line: Number(m[3]), column: Number(m[4]), severity: 'failure', message: `${m[1]}: ${m[5].trim()}`,
  })));
  return dedupe(out);
}

// Go

function parseGo(output: string): Diagnostic[] {
  const out = scan(output, /^(?:\.\/)?([\w./\\-]+\.go):(\d+):(?:(\d+):)?\s+(.+)$/gm, (m) => ({
    file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined, severity: 'error', message: m[4].trim(),
  }));
  out.push(...scan(output, /^\s*--- FAIL: (\S+)/gm, (m) => ({ file: '(test)', severity: 'failure', message: `${m[1]} failed` })));
  return dedupe(out);
}

// Terraform

function parseTerraform(output: string): Diagnostic[] {
  const out: any[] = [];
  const blocks = [...output.matchAll(/(Error|Warning):\s*([^\n]+)/g)];
  for (let i = 0; i < blocks.length; i++) {
    const seg = output.slice(blocks[i].index, blocks[i + 1]?.index);
    const loc = /on\s+([^\s]+\.tf)\s+line\s+(\d+)(?:, in\s+([^\n:│]+))?/.exec(seg);
    if (!loc) continue;
    out.push({ file: loc[1], line: Number(loc[2]), severity: blocks[i][1].toLowerCase(), message: `${blocks[i][2].trim()}${loc[3] ? ` (${loc[3].trim()})` : ''}` });
  }
  return dedupe(out);
}

// Git (a tool rather than a language, but it installs and reports errors the same way)

function parseGitConflicts(output: string): Diagnostic[] {
  const out = scan(output, /CONFLICT\s*\([^)]*\):\s*(.*)/g, (m) => {
    const rest = String(m[1] ?? '').trim();
    const file = /^Merge\s+conflict\s+in\s+([\w./-]+)/i.exec(rest)?.[1] ?? /^([\w./-]+)/.exec(rest)?.[1] ?? '(merge)';
    return { file, severity: 'error', message: rest || 'merge conflict' };
  });
  if (/Automatic merge failed/i.test(output) && out.length === 0) {
    out.push({ file: '(merge)', severity: 'error', message: 'automatic merge failed; fix conflicts and commit' });
  }
  return dedupe(out);
}

export const LANGUAGES: readonly Language[] = [
  {
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
    commandPattern: /\b(?:node|npm|npx|pnpm|yarn|tsc|jest|vitest|mocha)\b/,
    stackAliases: ['typescript'],
    parse: (t) => [...parseTypeScript(t), ...parseNodeTest(t), ...parseJest(t), ...parseVitest(t), ...parseMocha(t), ...parseNodeRuntime(t)],
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
    install: {
      strategies: [
        { strategy: 'fnm', args: ['install', '--lts'] },
        { strategy: 'nvm', args: ['--lts'] },
        { strategy: 'winget', packageId: 'OpenJS.NodeJS.LTS' },
        { strategy: 'scoop', package: 'nodejs' },
        { strategy: 'brew', formula: 'node' },
        { strategy: 'apt', package: 'nodejs' },
      ],
      hint: 'Install Node.js manually from nodejs.org, or via your system package manager.',
    },
  },
  {
    id: 'python',
    label: 'Python',
    runtimes: [
      { name: 'python', commands: (platform: string) => (platform === 'win32' ? ['python', 'py'] : ['python3', 'python']) },
      { name: 'pip', commands: (platform: string) => (platform === 'win32' ? ['pip'] : ['pip3', 'pip']) },
      { name: 'uv', commands: ['uv'] },
    ],
    markers: ['pyproject.toml', 'requirements.txt', 'setup.py', 'setup.cfg', 'Pipfile'],
    extensions: ['.py'],
    commands: {
      test: (py) => [py, '-m', 'pytest'],
      build: (py, marker) => (marker === 'pyproject.toml' ? [py, '-m', 'build'] : undefined),
      lint: (py) => [py, '-m', 'ruff', 'check', '.'],
    },
    commandPattern: /pytest|python/,
    parse: parsePytest,
    source: {
      symbols: [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/gm, /^\s*class\s+([A-Za-z_]\w*)/gm],
      imports: [/^\s*from\s+([\w.]+)\s+import\b/gm, /^\s*import\s+([\w.]+)/gm],
    },
    install: {
      strategies: [
        { strategy: 'winget', packageId: 'Python.Python.3.12' },
        { strategy: 'scoop', package: 'python' },
        { strategy: 'brew', formula: 'python' },
        { strategy: 'apt', package: 'python3' },
      ],
      hint: 'Install Python manually from python.org, or via your system package manager.',
    },
  },
  {
    id: 'dotnet',
    label: 'C# / .NET',
    runtimes: [{ name: 'dotnet', commands: ['dotnet'] }],
    markerPattern: DOTNET_PROJECT,
    extensions: ['.cs'],
    outputDirs: ['bin', 'obj'],
    detect: detectDotnet,
    commandPattern: /dotnet\b/,
    parse: parseDotnet,
    source: {
      symbols: [
        /^\s*(?:public|internal|private|protected)?\s*(?:static\s+|sealed\s+|abstract\s+|partial\s+)*?(?:class|interface|enum|record|struct)\s+([A-Za-z_]\w*)/gm,
        /^\s*namespace\s+([A-Za-z_][\w.]*)/gm,
      ],
      imports: [/^\s*using\s+([A-Za-z_][\w.]*)\s*;/gm],
    },
    install: {
      strategies: [
        { strategy: 'winget', packageId: 'Microsoft.DotNet.SDK.8' },
        { strategy: 'scoop', package: 'dotnet-sdk' },
        { strategy: 'brew', cask: true, formula: 'dotnet-sdk' },
      ],
      hint: 'Install the .NET SDK manually from dotnet.microsoft.com/download.',
    },
  },
  {
    id: 'rust',
    label: 'Rust',
    runtimes: [
      { name: 'cargo', commands: ['cargo'] },
      { name: 'rustc', commands: ['rustc'] },
    ],
    searchPaths: [path.join(os.homedir(), '.cargo', 'bin')],
    markers: ['Cargo.toml'],
    manifests: ['Cargo.lock'],
    extensions: ['.rs'],
    commands: {
      test: (cargo) => [cargo, 'test'],
      build: (cargo) => [cargo, 'build'],
      lint: (cargo) => [cargo, 'clippy'],
      run: (cargo) => [cargo, 'run'],
    },
    commandPattern: /\b(?:cargo|rustc)\b/,
    parse: parseCargo,
    source: {
      symbols: [/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, /^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+([A-Za-z_]\w*)/gm],
      imports: [/^\s*use\s+([\w:]+)/gm],
    },
    install: {
      strategies: [
        { strategy: 'rustup', args: ['toolchain', 'install', 'stable'] },
        { strategy: 'winget', packageId: 'Rustlang.Rustup' },
        { strategy: 'scoop', package: 'rustup' },
        { strategy: 'brew', formula: 'rustup' },
      ],
      hint: 'Install Rust manually with: curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh',
    },
  },
  {
    id: 'go',
    label: 'Go',
    runtimes: [{ name: 'go', commands: ['go'] }],
    markers: ['go.mod'],
    manifests: ['go.sum'],
    extensions: ['.go'],
    commands: {
      test: (go) => [go, 'test', './...'],
      build: (go) => [go, 'build', './...'],
      lint: (go) => [go, 'vet', './...'],
      run: (go) => [go, 'run', '.'],
    },
    commandPattern: /\bgo\s+(?:test|build|vet|run)\b/,
    parse: parseGo,
    source: {
      symbols: [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/gm, /^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/gm],
      imports: [/import\s*\(\s*([\s\S]*?)\)/g, /^\s*"([^"]+)"/gm],
    },
    install: {
      strategies: [
        { strategy: 'winget', packageId: 'GoLang.Go' },
        { strategy: 'scoop', package: 'go' },
        { strategy: 'brew', formula: 'go' },
        { strategy: 'apt', package: 'golang' },
      ],
      hint: 'Install Go manually from go.dev/dl.',
    },
  },
  {
    id: 'terraform',
    label: 'Terraform',
    runtimes: [{ name: 'terraform', commands: ['terraform'] }],
    markers: ['main.tf', 'provider.tf', 'backend.tf', 'terraform.tfvars', '.terraform.lock.hcl'],
    extensions: ['.tf'],
    commands: {
      test: (tf) => [tf, 'validate'],
      build: (tf) => [tf, 'fmt', '-check'],
      lint: (tf) => [tf, 'validate'],
      run: (tf) => [tf, 'plan'],
    },
    commandPattern: /terraform\b/,
    parse: parseTerraform,
    install: {
      strategies: [
        { strategy: 'winget', packageId: 'Hashicorp.Terraform' },
        { strategy: 'scoop', package: 'terraform' },
        { strategy: 'brew', formula: 'hashicorp/tap/terraform' },
      ],
      hint: 'Install Terraform manually from developer.hashicorp.com/terraform/downloads.',
    },
  },
  {
    id: 'git',
    label: 'Git',
    runtimes: [{ name: 'git', commands: ['git'] }],
    commandPattern: /\bgit\b/,
    parse: parseGitConflicts,
    install: {
      strategies: [
        { strategy: 'winget', packageId: 'Git.Git' },
        { strategy: 'scoop', package: 'git' },
        { strategy: 'brew', formula: 'git' },
        { strategy: 'apt', package: 'git' },
      ],
      hint: 'Install Git manually from git-scm.com.',
    },
  },
];

// Views of the table the rest of the code asks for.

const lower = (list: string[]) => list.map((f) => f.toLowerCase());

/** Other ecosystems whose projects we recognise and index, but have no toolchain support for yet. */
const OTHER_MARKERS = ['pom.xml', 'build.gradle', 'settings.gradle', 'composer.json', 'Gemfile'];

const MARKER_FILES: ReadonlySet<string> = new Set([...LANGUAGES.flatMap((l) => l.markers ?? []), ...OTHER_MARKERS]);

/** Does this filename mark the root of a project? */
export function isProjectMarker(basename: string): boolean {
  return MARKER_FILES.has(basename) || LANGUAGES.some((l) => l.markerPattern?.test(basename));
}

/** Does this folder hold a project marker (package.json, go.mod, a .csproj …)? An unreadable folder does not. */
export function holdsProjectMarker(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => isProjectMarker(name));
  } catch {
    return false;
  }
}

/** The direct subfolders of `dir` that hold a project marker, as absolute paths. */
export function projectDirsIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => path.join(dir, e.name))
      .filter((sub) => holdsProjectMarker(sub));
  } catch {
    return [];
  }
}

/** The nearest folder at or above `abs`, up to `root`, that holds a project marker; null when none does. */
export function projectFolderOf(root: string, abs: string): string | null {
  const top = path.resolve(root);
  // Inside the root by path.relative, which holds for a drive root (C:\) and for a differently-cased drive letter.
  const within = (dir: string) => {
    const rel = path.relative(top, dir);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  let dir = path.resolve(abs);
  if (!holdsProjectMarker(dir)) dir = path.dirname(dir);
  while (within(dir)) {
    if (holdsProjectMarker(dir)) return dir;
    if (path.relative(top, dir) === '') break;
    dir = path.dirname(dir);
  }
  return null;
}

/** Files whose change means a project's dependencies changed. */
export const MANIFEST_FILES: ReadonlySet<string> = new Set([...MARKER_FILES, ...LANGUAGES.flatMap((l) => l.manifests ?? [])]);

/** Same set, lower-cased, for case-insensitive path checks. */
export const MANIFEST_FILES_LOWER: ReadonlySet<string> = new Set(lower([...MANIFEST_FILES]));

/** Symbol and import patterns for a source file extension, or null when no language claims it. */
export function sourceRulesFor(ext: string): Language['source'] | null {
  const e = ext.toLowerCase();
  return LANGUAGES.find((l) => l.source && l.extensions?.includes(e))?.source ?? null;
}

/** Diagnostics from tool output, from every language that owns the stack or recognises the command. */
export function parseForStack(text: string, stack: string | undefined, command: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const lang of LANGUAGES) {
    if (!lang.parse) continue;
    const owns = !stack || stack === lang.id || Boolean(lang.stackAliases?.includes(stack));
    if (owns || lang.commandPattern?.test(command)) out.push(...lang.parse(text));
  }
  return dedupe(out);
}

/** The build output folders of every kind of project rooted at `root`, as absolute paths. */
export function outputDirsAt(root: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const rootedHere = (language: Language) =>
    names.some((name) => language.markers?.includes(name) || language.markerPattern?.test(name));
  return LANGUAGES.filter((language) => language.outputDirs?.length && rootedHere(language))
    .flatMap((language) => language.outputDirs!.map((dir) => path.join(root, dir)));
}
