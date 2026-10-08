import fsp from 'node:fs/promises';
import path from 'node:path';

import { defineTool } from '../core/defineTool';
import { ok, fromError } from '../core/tool-result';
import { isSkippedDir } from './_fs';
import { STORAGE } from '../../protocol';

/** Folders ocode itself keeps in a workspace: listed when asked for, but never mistaken for the project. */
const OWN_DIRS: ReadonlySet<string> = new Set([STORAGE.PROJECT_DIR]);
const OWN_NOTE = "ocode's own data, not part of the project";

const MAX_ENTRIES = 500;
/** Entries one listing shows in all, its subfolders' included: a small project comes back whole in one call. */
const TREE_BUDGET = 150;
const TREE_DEPTH = 4;

interface Entry { name: string; type: string; size?: number; children?: Entry[]; unexpanded?: number }

/** A subfolder's entries as the top level shows them: no hidden, build or vendor folders, folders first. */
async function readEntries(abs: string, showAll: boolean): Promise<Entry[]> {
  const dirents = await fsp.readdir(abs, { withFileTypes: true }).catch((): import('node:fs').Dirent[] => []);
  const entries = await Promise.all(dirents
    .filter((e) => showAll || (!e.name.startsWith('.') && !(e.isDirectory() && isSkippedDir(e.name))))
    .map(async (e) => {
      const type = e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file';
      const size = type === 'file' ? await fsp.stat(path.join(abs, e.name)).then((st) => st.size).catch((): undefined => undefined) : undefined;
      return { name: e.name, type, size } as Entry;
    }));
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
}

/**
 * Fills in subfolders level by level, nearest first, while the whole listing stays within TREE_BUDGET: one call
 * shows a small project entire instead of one call per folder. A folder that would not fit says how much it holds.
 * Hidden, build, vendor and ocode's own folders are never opened.
 */
async function expandTree(top: Entry[], abs: string): Promise<number> {
  let shown = top.length;
  let level: Array<{ entry: Entry; abs: string }> = top.filter(opens).map((entry) => ({ entry, abs: path.join(abs, entry.name) }));
  for (let depth = 1; depth < TREE_DEPTH && level.length; depth++) {
    const next: typeof level = [];
    for (const { entry, abs: dir } of level) {
      const children = await readEntries(dir, false);
      if (shown + children.length > TREE_BUDGET) {
        entry.unexpanded = children.length;
        continue;
      }
      entry.children = children;
      shown += children.length;
      next.push(...children.filter(opens).map((child) => ({ entry: child, abs: path.join(dir, child.name) })));
    }
    level = next;
  }
  return shown - top.length;
}

function opens(e: Entry): boolean {
  return e.type === 'directory' && !e.name.startsWith('.') && !isSkippedDir(e.name) && !OWN_DIRS.has(e.name);
}

function treeLines(entries: Entry[], indent: string): string[] {
  return entries.flatMap((e) => [
    `${indent}${e.type === 'directory' ? `${e.name}/` : e.name}${e.size !== undefined ? ` (${e.size}B)` : ''}` +
      (e.unexpanded !== undefined ? ` (${e.unexpanded} entr${e.unexpanded === 1 ? 'y' : 'ies'}, not opened)` : ''),
    ...(e.children ? treeLines(e.children, `${indent}  `) : []),
  ]);
}

function countFiles(entries: Entry[]): number {
  return entries.reduce((n, e) => n + (e.type === 'file' ? 1 : 0) + countFiles(e.children ?? []), 0);
}

export default defineTool({
  name: 'list_directory',
  aliases: ['list_files', 'ls', 'dir'],
  argAliases: {
    dir: 'path',
    directory: 'path',
    folder: 'path',
  },
  profiles: ['core', 'planning', 'always'],
  category: 'filesystem',
  activity: 'Listing a directory',
  label: 'List Directory',
  brief: 'List a directory, with its subfolders\' contents while the listing stays small. Build and vendor folders are hidden unless all:true.',
  description:
    'List files and subdirectories of a workspace directory. Subfolders are listed inside it, nearest first, while the whole listing stays under ' +
    `${TREE_BUDGET} entries, so a small project comes back entire; a subfolder left out says how many entries it holds. Build/vendor directories are hidden by default.`,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative directory (default ".")' },
      all: { type: 'boolean', description: 'Include hidden and build directories' },
    },
    required: [],
  },
  async execute(args, ctx) {
    try {
      const abs = args.path ? String(args.path) : ctx.ws.root;
      const rel = ctx.ws.rel(abs);
      const showAll = Boolean(args.all);

      const dirents = await fsp.readdir(abs, { withFileTypes: true });
      const filtered = dirents.filter((e) => {
        if (showAll) return true;
        if (e.name.startsWith('.')) return false;
        return !(e.isDirectory() && isSkippedDir(e.name));
      });

      const entries: Entry[] = await Promise.all(
        filtered.slice(0, MAX_ENTRIES).map(async (e) => {
          const type = e.isSymbolicLink() ? 'symlink' : e.isDirectory() ? 'directory' : 'file';
          let size;
          if (type === 'file') {
            size = await fsp.stat(path.join(abs, e.name)).then((s) => s.size).catch((): undefined => undefined);
          }
          return { name: e.name, type, size };
        })
      );

      entries.sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1
      );

      const hidden = dirents.length - filtered.length;
      const truncated = filtered.length > MAX_ENTRIES;
      const atRoot = path.resolve(abs) === path.resolve(ctx.ws.root);
      const nested = truncated ? 0 : await expandTree(entries, abs);
      const lines = entries.flatMap((e) => {
        const [head, ...inside] = treeLines([e], '');
        return [head + (atRoot && e.type === 'directory' && OWN_DIRS.has(e.name) ? ` — ${OWN_NOTE}` : ''), ...inside];
      });
      const insideOwn = OWN_DIRS.has(rel.split(/[\\/]/)[0]);
      if (truncated) lines.push(`…and ${filtered.length - MAX_ENTRIES} more`);
      if (hidden > 0 && !showAll) lines.push(`(${hidden} hidden/build entries omitted; pass all:true to include)`);

      // Say the count rather than leaving it to be counted.
      const fileCount = entries.filter((e) => e.type === 'file').length;
      const dirCount = entries.length - fileCount;
      const parts = [`${fileCount} file${fileCount === 1 ? '' : 's'}`];
      if (dirCount > 0) parts.push(`${dirCount} director${dirCount === 1 ? 'y' : 'ies'}`);
      const inAll = countFiles(entries);
      const tally = truncated
        ? `${entries.length} shown of ${filtered.length}`
        : parts.join(', ') + (nested > 0 && inAll > fileCount ? `; ${inAll} files in all, subfolders listed below` : '');

      return ok({
        kind: 'listing',
        display: `${rel} — ${tally}${insideOwn ? ` (${OWN_NOTE})` : ''}:\n${lines.join('\n')}`,
        truncated,
        data: { path: rel, entries: entries.map(({ children: _c, unexpanded: _u, ...e }) => e), total: filtered.length, hidden },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

