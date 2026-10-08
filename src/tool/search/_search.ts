import fsp from 'node:fs/promises';

import { walkFiles, isBinaryFile, relTo } from '../filesystem/_fs';
import { makeGlobMatcher } from './_glob';

const MAX_LINE_CHARS = 300;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

interface SearchMatch {
  file: string;
  line: number;
  text: string;
}

interface ScanContentOptions {
  root: string;
  base: string;
  test: (line: string) => boolean;
  testFallback?: ((line: string) => boolean) | null;
  include?: string;
  exclude?: string;
  allFiles?: boolean;
  maxResults?: number;
  contextLines?: number;
  signal?: AbortSignal;
}

export async function scanContent({
  root,
  base,
  test,
  testFallback,
  include,
  exclude,
  allFiles = false,
  maxResults = 100,
  contextLines = 0,
  signal,
}: ScanContentOptions): Promise<{ matches: SearchMatch[]; truncated: boolean; filesScanned: number; fallbackMatches: SearchMatch[]; fallbackTruncated: boolean; skippedLarge: number; skippedUnreadable: number; }> {
  const matchesGlob = makeGlobMatcher(include, { caseSensitive: false });
  const rawExclude = exclude && String(exclude).trim() !== '' ? String(exclude).trim() : '';
  const excludeGlob = rawExclude ? makeGlobMatcher(rawExclude, { caseSensitive: false }) : () => false;
  const userBareWords = rawExclude
    ? rawExclude.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && !/[*?[\]{}/]/.test(s))
    : [];
  const matches: SearchMatch[] = [];
  const fallbackMatches: SearchMatch[] = [];
  let truncated = false;
  let fallbackTruncated = false;
  let skippedLarge = 0;
  let skippedUnreadable = 0;
  let filesScanned = 0;

  const stat = await fsp.stat(root).catch((): null => null);
  let source;
  if (stat?.isFile()) {
    source = [{ abs: root }];
  } else {
    source = walkFiles(root, { signal, allFiles });
  }

  /** Manifests, lockfiles and build output are skipped unless the search points at them explicitly. */
  const DEFAULT_EXCLUDE_WORDS = [
    'node_modules',
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
    'dist', 'build', 'out', 'bin', 'obj', 'target', '.next', 'coverage', '__pycache__',
  ];
  const rootSegs = relTo(base, root).split('/').filter((s) => s && s !== '.');
  const activeDefaults = stat?.isFile()
    ? []
    : DEFAULT_EXCLUDE_WORDS.filter((w) => !rootSegs.includes(w));
  const bareExcludeWords = [...activeDefaults, ...userBareWords];
  const isExcluded = (rel: string) => {
    if (excludeGlob(rel)) return true;
    if (bareExcludeWords.length === 0) return false;
    const segs = rel.toLowerCase().split('/');
    return bareExcludeWords.some((w) => segs.includes(w));
  };

  for await (const { abs } of source) {
    const rel = relTo(base, abs);
    if (signal?.aborted) break;
    if (matches.length >= maxResults) {
      truncated = true;
      break;
    }
    if (!matchesGlob(rel)) continue;
    if (isExcluded(rel)) continue;

    let content;
    try {
      const st = await fsp.stat(abs);
      if (st.size > MAX_FILE_BYTES) {
        skippedLarge += 1;
        continue;
      }
      if (!allFiles && (await isBinaryFile(abs))) continue;
      content = await fsp.readFile(abs, 'utf8');
    } catch {
      skippedUnreadable += 1;
      continue; // unreadable file: skip it, never abort the run
    }
    filesScanned += 1;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }
      const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i];
      const sliceLine = (s: string) => {
        const t = s.trim();
        return t.length > MAX_LINE_CHARS ? `${t.slice(0, MAX_LINE_CHARS)}…[truncated]` : t;
      };
      if (!test(line)) {
        if (testFallback && testFallback(line)) {
          if (fallbackMatches.length >= maxResults) fallbackTruncated = true;
          else fallbackMatches.push({ file: rel, line: i + 1, text: sliceLine(line) });
        }
        continue;
      }

      if (contextLines > 0) {
        const from = Math.max(0, i - contextLines);
        const to = Math.min(lines.length - 1, i + contextLines);
        const block = lines
          .slice(from, to + 1)
          .map((l, k) => {
            const clean = l.endsWith('\r') ? l.slice(0, -1) : l;
            const t = clean.length > MAX_LINE_CHARS ? `${clean.slice(0, MAX_LINE_CHARS)}…[truncated]` : clean;
            return `${from + k + 1}: ${t}`;
          })
          .join('\n');
        matches.push({ file: rel, line: i + 1, text: block });
      } else {
        matches.push({ file: rel, line: i + 1, text: sliceLine(line) });
      }
    }
  }

  return { matches, truncated, filesScanned, fallbackMatches, fallbackTruncated, skippedLarge, skippedUnreadable };
}

export function renderMatches(matches: SearchMatch[], truncated: boolean, maxResults?: number): string {
  if (matches.length === 0) return '(no matches)';
  const body = matches
    .map((m) => (m.line > 0 ? `${m.file}:${m.line}: ${m.text}` : m.file))
    .join('\n');
  return truncated
    ? `${body}\n…result limit reached (${maxResults}); narrow the search with include or path.`
    : body;
}

export async function reconcileSearchScope(args: { path?: string; include?: string; }, statPath: (p: string) => Promise<'file' | 'dir' | 'symlink' | null>): Promise<{ path?: string; include?: string; note?: string; }> {
  const include = args.include;
  if (!include || /[*?[\]{}]/.test(include)) return { path: args.path, include };

  if (args.path === undefined && (await statPath(include)) === 'dir') {
    return {
      path: include,
      include: undefined,
      note: `interpreted include:"${include}" as the directory to search`,
    };
  }
  return { path: args.path, include };
}

