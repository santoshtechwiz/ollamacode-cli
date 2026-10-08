import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { walkFiles, relTo } from '../filesystem/_fs';
import { makeGlobMatcher } from './_glob';

const DEFAULT_LIMIT = 100;
const HARD_LIMIT = 1000;

export default defineTool({
  name: 'find_files',
  aliases: ['find', 'glob'],
  argAliases: {
    glob: 'pattern',
    name: 'pattern',
    query: 'pattern',
  },
  profiles: ['core', 'planning'],
  category: 'search',
  readOnly: true,
  activity: 'Looking for files',
  label: 'Find Files',
  brief: 'Find files by NAME using a glob ("*.test.ts", "src/**/*.ts"). Searches names, not contents.',
  description:
    'Find files by name or glob (e.g. "*.test.ts", "src/**/*.ts", "package.json"). Searches names, not contents — use grep_content to search inside files. Build and vendor directories are skipped.',
  parameters: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Glob to match. No slash matches the file name anywhere in the tree ("*.ts"); a slash matches the workspace-relative path ("src/**/*.ts"). Comma-separate alternatives.',
      },
      path: { type: 'string', pathArg: true, description: 'Directory to search under (default: the workspace root)' },
      limit: { type: 'number', description: `Maximum results (default ${DEFAULT_LIMIT}, max ${HARD_LIMIT})` },
      all: { type: 'boolean', description: 'Include hidden and build directories' },
    },
    required: ['pattern'],
  },

  preview(args) {
    return `find ${args?.pattern}`;
  },

  async execute(args, ctx) {
    try {
      const pattern = String(args.pattern ?? '').trim();
      if (!pattern) {
        return fail('pattern is required', {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Pass a glob such as "*.test.ts" or "src/**/*.ts".',
        });
      }

      const base = args.path ? await ctx.ws.resolve(String(args.path)) : ctx.ws.root;
      const limit = Math.min(Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : DEFAULT_LIMIT, HARD_LIMIT);
      const matches = makeGlobMatcher(pattern, { caseSensitive: false });

      const found: string[] = [];
      let capped = false;
      for await (const { abs } of walkFiles(base, { signal: ctx.signal, allFiles: Boolean(args.all) })) {
        if (ctx.signal?.aborted) break;
        const relBase = relTo(base, abs);
        const relWs = ctx.ws.rel(abs);
        // A glob may be written against the search directory or against the workspace root; either reading counts as a match.
        if (!matches(relBase) && !matches(relWs)) continue;
        found.push(relWs);
        if (found.length >= HARD_LIMIT) {
          capped = true;
          break;
        }
      }

      if (found.length === 0) {
        return ok({
          kind: 'listing',
          display: `No files match ${pattern}`,
          data: { pattern, matches: [], count: 0 },
        });
      }

      found.sort((a, b) => {
        const depth = a.split('/').length - b.split('/').length;
        return depth !== 0 ? depth : a.localeCompare(b);
      });
      const truncated = found.length > limit;
      const page = truncated ? found.slice(0, limit) : found;

      const display = page.join('\n') + (truncated ? `\n… (showing ${limit} of ${found.length}${capped ? '+' : ''} matches)` : '');
      return ok({
        kind: 'listing',
        display,
        truncated,
        data: { pattern, matches: page, count: page.length, total: found.length, truncated },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

