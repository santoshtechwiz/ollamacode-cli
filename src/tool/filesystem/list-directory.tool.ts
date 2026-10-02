import fsp from 'node:fs/promises';
import path from 'node:path';

import { defineTool } from '../core/defineTool';
import { ok, fromError } from '../core/tool-result';
import { isSkippedDir } from './_fs';
import { STORAGE } from '../../protocol';

/** Folders ocode itself keeps in a workspace: listed when asked for, but never mistaken for the project. */
const OWN_DIRS: ReadonlySet<string> = new Set([STORAGE.PROJECT_DIR, STORAGE.INDEX_DIR]);
const OWN_NOTE = "ocode's own data, not part of the project";

const MAX_ENTRIES = 500;

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
  brief: 'List one directory. Build and vendor folders are hidden unless all:true.',
  description:
    'List files and subdirectories of a workspace directory. Build/vendor directories are hidden by default.',
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

      const entries = await Promise.all(
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
      const lines = entries.map(
        (e) =>
          `${e.type === 'directory' ? `${e.name}/` : e.name}${e.size !== undefined ? ` (${e.size}B)` : ''}` +
          (atRoot && e.type === 'directory' && OWN_DIRS.has(e.name) ? ` — ${OWN_NOTE}` : '')
      );
      const insideOwn = OWN_DIRS.has(rel.split(/[\\/]/)[0]);
      if (truncated) lines.push(`…and ${filtered.length - MAX_ENTRIES} more`);
      if (hidden > 0 && !showAll) lines.push(`(${hidden} hidden/build entries omitted; pass all:true to include)`);

      // Say the count rather than leaving it to be counted.
      const fileCount = entries.filter((e) => e.type === 'file').length;
      const dirCount = entries.length - fileCount;
      const parts = [`${fileCount} file${fileCount === 1 ? '' : 's'}`];
      if (dirCount > 0) parts.push(`${dirCount} director${dirCount === 1 ? 'y' : 'ies'}`);
      const tally = truncated ? `${entries.length} shown of ${filtered.length}` : parts.join(', ');

      return ok({
        kind: 'listing',
        display: `${rel} — ${tally}${insideOwn ? ` (${OWN_NOTE})` : ''}:\n${lines.join('\n')}`,
        truncated,
        data: { path: rel, entries, total: filtered.length, hidden },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

