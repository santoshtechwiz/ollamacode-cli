import path from 'node:path';

import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, clamp } from '../core/tool-result';

const MAX_DISPLAY = 20_000;
const MAX_LIMIT = 100;

/** One symbol matched by the index, with the file that defines it. */
interface Match {
  name: string;
  kind: string;
  file: string;
}

/** Escape `%`, `_` and `\` so a query is a substring match, not a wildcard. */
function likePattern(s: string): string {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export default defineTool({
  name: 'search_symbols',
  profiles: ['core', 'planning'],
  category: 'search',
  activity: 'Searching for a symbol',
  label: 'Search Symbols',
  brief: 'Search the workspace index for symbols by name.',
  description: `Search the workspace index for symbols (functions, classes, types, module names)
whose names contain the search text, case-insensitively. Returns the files that define them.
Uses the workspace index; definitions are file-level, not line-accurate.`,
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text the symbol name must contain (substring search)' },
      kind: { type: 'string', description: 'Optional symbol kind filter (function/class/type/…)', enum: ['symbol', 'function', 'class', 'type', 'module'] },
      limit: { type: 'integer', description: `Max matches to return (default 20, max ${MAX_LIMIT})` },
    },
    required: ['query'],
  },

  preview(args) {
    return `symbols ~ ${args?.query}`;
  },

  async execute(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) {
      return fail('query is required', { code: TOOL_ERROR_CODE.EINVAL });
    }

    const index = (ctx as any)?.state?.index as import('../../context/workspace-index/_shared.ts').IndexHandle | null;
    if (!index?.db) {
      return fail('The workspace index is not available for this session.', {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Use grep_content to locate the symbol instead.',
      });
    }

    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(args.limit) || 20));

    try {
      const db = index.db;
      const kind = String(args.kind ?? '').trim();
      const params: any[] = [likePattern(query.toLowerCase())];
      let kindSql = '';
      if (kind) {
        kindSql = ' AND LOWER(s.kind) = ?';
        params.push(kind.toLowerCase());
      }
      params.push(limit);

      const rows = db
        .prepare(
          `SELECT s.kind AS kind, s.name AS name, p.root AS proot, f.rel_path AS rel
           FROM symbols s
           JOIN files f ON f.id = s.file_id
           JOIN projects p ON p.id = f.project_id
           WHERE LOWER(s.name) LIKE ? ESCAPE '\\'${kindSql}
           ORDER BY s.name
           LIMIT ?`
        )
        .all(...params) as Array<{ kind: string; name: string; proot: string; rel: string; }>;

      const matches: Match[] = rows.map((r) => ({
        name: r.name,
        kind: r.kind,
        file: ctx.ws.rel(path.join(r.proot, r.rel)),
      }));

      const byFile = new Map<string, string[]>();
      for (const m of matches) {
        const list = byFile.get(m.file) ?? [];
        list.push(`${m.name} (${m.kind})`);
        byFile.set(m.file, list);
      }

      let body = `query: ${query} — ${matches.length} match(es)`;
      if (matches.length > 0) {
        body += `\n${[...byFile.entries()].map(([file, names]) => `  ${file}: ${names.join(', ')}`).join('\n')}`;
      }
      const { text, truncated } = clamp(body, MAX_DISPLAY);

      return ok({
        kind: 'matches',
        display: text + (truncated ? '\n…[truncated]' : ''),
        data: {
          query,
          matches,
          count: matches.length,
        },
      });
    } catch (err) {
      return fail((err as Error)?.message ?? String(err), { code: TOOL_ERROR_CODE.EUNKNOWN });
    }
  },
});