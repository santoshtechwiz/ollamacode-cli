import { TOOL_ERROR_CODE } from '../../protocol';
import { escapeRegExp } from '../../core/text-utils';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { statType } from '../filesystem/_fs';
import { compilePattern } from './_glob';
import { scanContent, renderMatches, reconcileSearchScope } from './_search';

const MAX_RESULTS = 100;
const HARD_MAX_RESULTS = 500;

export default defineTool({
  name: 'grep_content',
  aliases: ['grep', 'search'],
  argAliases: {
    regex: 'pattern',
    query: 'pattern',
  },
  profiles: ['core', 'planning'],
  category: 'search',
  readOnly: true,
  activity: 'Searching file contents',
  label: 'Grep Content',
  brief: 'Search INSIDE files with a regular expression. Returns file:line matches.',
  description:
    'Search file contents with a regular expression (like ripgrep). Returns file:line matches. Supports include/exclude globs and binary/hidden-file scans. To find files by name, use find_files. To count, group or compare matches across files, use run_script.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      path: { type: 'string', pathArg: true, description: 'A file or directory to search. Leave it out to search the whole workspace.' },
      include: { type: 'string', description: 'Comma-separated globs limiting which files are searched, e.g. "*.ts" or "src/**/*.ts"' },
      exclude_glob: { type: 'string', description: 'Comma-separated globs of paths to skip, e.g. "dist/**,**/*.min.ts". node_modules, lockfiles and build dirs are always skipped.' },
      case_sensitive: { type: 'boolean', description: 'Match case exactly (default false)' },
      context: { type: 'number', description: 'Lines of context around each match (max 5)' },
      all_files: { type: 'boolean', description: 'Also search hidden directories and binary files (default false)' },
      max_results: { type: 'number', description: `Maximum matches to return (default ${MAX_RESULTS}, max ${HARD_MAX_RESULTS})` },
    },
    required: ['pattern'],
  },
  async execute(args, ctx) {
    try {
      const caseSensitive = args.case_sensitive === true;
      const rawPattern = String(args.pattern ?? '');
      let compiled = compilePattern(rawPattern, { caseSensitive });
      let invalidAsRegex = false;
      if ('error' in compiled) {
        const literalFirst = compilePattern(escapeRegExp(rawPattern), { caseSensitive });
        if ('error' in literalFirst) return fail(compiled.error, { code: TOOL_ERROR_CODE.EINVAL });
        compiled = literalFirst;
        invalidAsRegex = true;
      }

      const scope = await reconcileSearchScope(args, async (p) => {
        try {
          return (await statType(await ctx.ws.resolve(p)))?.type ?? null;
        } catch {
          return null;
        }
      });
      const root = await ctx.ws.resolve(scope.path || '.');
      const requestedContext = Number(args.context) > 0 ? Math.floor(Number(args.context)) : 0;
      const contextLines = Math.min(requestedContext, 5);
      const contextClamped = requestedContext > 5;
      const maxResults = Math.min(Math.max(Number(args.max_results) || MAX_RESULTS, 1), HARD_MAX_RESULTS);

      const literalPattern = escapeRegExp(rawPattern);
      const literalCompiled =
        literalPattern !== rawPattern ? compilePattern(literalPattern, { caseSensitive }) : null;

      const scan = await scanContent({
        root,
        base: ctx.ws.root,
        test: (s) => compiled.re.test(s),
        testFallback:
          !invalidAsRegex && literalCompiled && !('error' in literalCompiled)
            ? (s) => literalCompiled.re.test(s)
            : undefined,
        include: scope.include,
        exclude: args.exclude_glob,
        allFiles: Boolean(args.all_files),
        maxResults,
        contextLines,
        signal: ctx.signal,
      });

      const { truncated, filesScanned, fallbackMatches, fallbackTruncated, skippedLarge, skippedUnreadable } = scan;
      let matches = scan.matches;

      let fallbackNote = '';
      if (invalidAsRegex) {
        fallbackNote = `(pattern "${rawPattern}" is not valid regex — searched as literal text instead)\n\n`;
      } else if (matches.length === 0 && fallbackMatches.length > 0) {
        matches = fallbackMatches;
        fallbackNote =
          `(no regex match for "${rawPattern}" — that pattern contains regex syntax like ( ) [ ] ` +
          `. * ? — showing matches for it as literal text instead)\n\n`;
      }
      let literalHint = '';
      if (!fallbackNote && matches.length > 0 && fallbackMatches.length > 0 && !invalidAsRegex) {
        literalHint = `\nNote: pattern also matches literally in ${fallbackMatches.length} line(s); regex reading shown.`;
      }
      const notes: string[] = [];
      if (scope.note) notes.push(scope.note);
      if (contextClamped) notes.push(`context clamped to 5 (asked ${requestedContext})`);
      if (fallbackTruncated) notes.push('literal matches truncated at result limit');
      if (skippedLarge > 0) notes.push(`${skippedLarge} file(s) skipped (>2MB)`);
      if (skippedUnreadable > 0) notes.push(`${skippedUnreadable} unreadable file(s) skipped`);
      const notePrefix = notes.length > 0 ? `(${notes.join('; ')})\n\n` : '';

      // Its own output was cut: paging through it by hand is the slow way to count or group what it found.
      const modelNote = truncated
        ? 'There are more matches than shown. To count, group or filter all of them, a run_script does it in one call.'
        : undefined;
      return {
        ...ok({
          kind: 'matches',
          display: `${notePrefix}${fallbackNote}${renderMatches(matches, truncated, maxResults)}${literalHint}`,
          truncated,
          data: {
            matches,
            total: matches.length,
            filesScanned,
            pattern: rawPattern,
            literalFallback: Boolean(fallbackNote),
            literalMatches: fallbackMatches.length,
            skippedLarge,
            skippedUnreadable,
          },
        }),
        ...(modelNote ? { modelNote } : {}),
      };
    } catch (err) {
      return fromError(err);
    }
  },
});

