/** The workspace's relative-import graph, built from code_review's per-file analysis. */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { walkFiles } from '../filesystem/_fs';
import { analyzeSource, isAnalyzable, type FileAnalysis } from './_analysis';
import { analyzePolyglot, hasPolyglotRules } from './_polyglot';

const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 512 * 1024;
const RESOLVE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export interface ProjectFile {
  rel: string;
  text: string;
  analysis: FileAnalysis;
}

export interface Project {
  root: string;
  files: Map<string, ProjectFile>;
  /** rel → rels it imports at runtime (relative imports that resolve inside the workspace; type-only imports are erased and left out). */
  edges: Map<string, Set<string>>;
  /** rel → names other files import from it; "*" means every export counts as used. */
  importedNames: Map<string, Set<string>>;
  /** The walk stopped at MAX_FILES. */
  partial: boolean;
}

const toPosix = (p: string) => p.split(path.sep).join('/');

/** Files code_review can analyze: JS/TS with the TypeScript parser, the rest with a shipped tree-sitter grammar. */
export function isReviewable(file: string): boolean {
  return isAnalyzable(file) || hasPolyglotRules(file);
}

/** One file's analysis, whichever parser covers it; null when none does. */
export async function analyzeFile(rel: string, text: string): Promise<FileAnalysis | null> {
  return isAnalyzable(rel) ? analyzeSource(rel, text) : analyzePolyglot(rel, text);
}

/** Parse every reviewable file under `root` (skipping node_modules, build output and dot-dirs) and link their relative imports. */
export async function loadProject(root: string, { signal }: { signal?: AbortSignal } = {}): Promise<Project> {
  const files = new Map<string, ProjectFile>();
  let partial = false;
  for await (const { abs, rel } of walkFiles(root, { signal })) {
    if (!isReviewable(abs)) continue;
    if (files.size >= MAX_FILES) {
      partial = true;
      break;
    }
    const stat = await fsp.stat(abs).catch((): null => null);
    if (!stat || stat.size > MAX_FILE_BYTES) continue;
    const text = await fsp.readFile(abs, 'utf8').catch((): null => null);
    if (text === null) continue;
    const key = toPosix(rel);
    const analysis = await analyzeFile(key, text);
    if (analysis) files.set(key, { rel: key, text, analysis });
  }

  const edges = new Map<string, Set<string>>();
  const importedNames = new Map<string, Set<string>>();
  for (const file of files.values()) {
    const out = new Set<string>();
    for (const imp of file.analysis.imports) {
      const target = resolveImport(file.rel, imp.source, files);
      if (!target) continue;
      if (!imp.typeOnly) out.add(target);
      const names = importedNames.get(target) ?? new Set<string>();
      for (const b of imp.bindings) names.add(b.imported);
      importedNames.set(target, names);
    }
    edges.set(file.rel, out);
  }
  return { root, files, edges, importedNames, partial };
}

/** The workspace file a relative specifier names, trying the extensions and index files Node/TS/bundlers would. */
export function resolveImport(fromRel: string, source: string, files: Map<string, unknown>): string | null {
  if (!source.startsWith('./') && !source.startsWith('../')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), source));
  const stem = base.replace(/\.(?:m|c)?[jt]sx?$/i, '');
  const candidates = [base, ...RESOLVE_EXTS.map((e) => stem + e), ...RESOLVE_EXTS.map((e) => `${base}/index${e}`)];
  return candidates.find((c) => files.has(c)) ?? null;
}

/** One concrete import cycle per strongly connected component: the shortest path from its first file back to itself. */
export function findCycles(edges: Map<string, Set<string>>): string[][] {
  return stronglyConnected(edges).map((component) => {
    const members = new Set(component);
    const start = component[0];
    const prev = new Map<string, string>();
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const v = queue[i];
      for (const w of edges.get(v) ?? []) {
        if (!members.has(w)) continue;
        if (w === start) {
          const path = [start];
          for (let at: string | undefined = v; at && at !== start; at = prev.get(at)) path.splice(1, 0, at);
          return [...path, start];
        }
        if (!prev.has(w)) {
          prev.set(w, v);
          queue.push(w);
        }
      }
    }
    return [...component, start];
  });
}

/** Strongly connected components with more than one file, or a file importing itself (Tarjan). */
function stronglyConnected(edges: Map<string, Set<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];

  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!));
      }
    }
    if (low.get(v) === idx.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      if (component.length > 1 || edges.get(v)?.has(v)) out.push(component.sort());
    }
  };

  for (const v of [...edges.keys()].sort()) if (!idx.has(v)) strong(v);
  return out;
}

/** Files nothing is expected to import: tests, scripts, configs, CLI entry points, declaration files. */
export function isEntryLike(rel: string): boolean {
  return (
    /(?:^|\/)(?:tests?|__tests__|spec|scripts|bin|e2e|fixtures?)\//.test(rel) ||
    /\.(?:test|spec|config|setup|stories)\.[^/]+$/.test(rel) ||
    /(?:^|\/)(?:index|main|cli|server|app)\.[^/]+$/.test(rel)
  );
}

export interface UnusedReport {
  exports: Array<{ file: string; line: number; name: string }>;
  imports: Array<{ file: string; line: number; name: string; source: string }>;
  files: string[];
}

/** Exports no workspace file imports, imports never referenced, and files nothing imports. Heuristic: dynamic access is invisible. */
export function findUnused(project: Project, inScope: (rel: string) => boolean = () => true): UnusedReport {
  const report: UnusedReport = { exports: [], imports: [], files: [] };
  const importedBy = new Set<string>();
  for (const targets of project.edges.values()) for (const t of targets) importedBy.add(t);

  for (const file of project.files.values()) {
    if (!inScope(file.rel)) continue;
    for (const imp of file.analysis.unusedImports) report.imports.push({ file: file.rel, ...imp });
    // Only JS/TS files are linked into the import graph, so only they can be judged unimported.
    if (!isAnalyzable(file.rel) || isEntryLike(file.rel)) continue;
    const used = project.importedNames.get(file.rel);
    if (!importedBy.has(file.rel)) {
      report.files.push(file.rel);
      continue;
    }
    if (used?.has('*')) continue;
    for (const exp of file.analysis.exports) {
      // Still used inside its own file, so only the `export` keyword is surplus, not the code.
      const localUses = file.analysis.identifierCounts.get(exp.name) ?? 0;
      if (exp.name !== 'default' && localUses > 1) continue;
      if (!used?.has(exp.name)) report.exports.push({ file: file.rel, line: exp.line, name: exp.name });
    }
  }
  return report;
}
