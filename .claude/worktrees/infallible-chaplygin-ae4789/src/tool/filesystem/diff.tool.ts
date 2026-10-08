import { defineTool } from '../core/defineTool';
import { ok, fail, fromError, clamp } from '../core/tool-result';
import { git, assertRepo, containPaths, buildDiffArgv, parseNumstat } from '../git/_git';

const MAX_OUTPUT = 20_000;

export default defineTool({
  name: 'diff',
  profiles: ['core', 'planning'],
  category: 'filesystem',
  activity: 'Comparing changes',
  label: 'Diff',
  brief: 'Show code changes against a previous version, as a concise code-focused diff.',
  description: `Compare the current code changes against the previous version.

Return a concise code-focused diff showing:
- Added, removed, and modified lines
- Affected functions, classes, methods, and types
- Changed imports/exports
- Potential accidental or unrelated changes
- Suspicious logic changes or regressions

Use this after editing code to verify that only the intended changes were made.

Do not treat formatting-only changes as important unless they affect behavior.
Do not rewrite or modify files.
Do not claim the change is correct; only report what changed and any issues visible from the diff.`,
  parameters: {
    type: 'object',
    properties: {
      base: { type: 'string', description: 'Ref to compare from (default HEAD)' },
      target: { type: 'string', description: 'Ref to compare against; omit for the working tree' },
      staged: { type: 'boolean', description: 'Diff the index instead of the working tree' },
      paths: { type: 'string', description: 'Space-separated files or directories to restrict the diff to' },
      context: { type: 'number', description: 'Context lines per hunk (default 3)' },
    },
    required: [],
  },

  preview(args) {
    const base = String(args?.base ?? 'HEAD');
    const target = String(args?.target ?? '');
    return `git diff ${args?.staged ? '--cached ' : ''}${base}${target ? `..${target}` : ''}`;
  },

  async execute(args, ctx) {
    try {
      await assertRepo(ctx.cwd, ctx.signal);
      const paths = await containPaths(ctx, args.paths);
      const context = Number(args.context) > 0 ? Math.min(Math.floor(Number(args.context)), 10) : 3;

      const baseArgv = buildDiffArgv({ staged: args.staged, base: args.base, target: args.target, context });
      const withPaths = (flag?: string) => (flag ? [...baseArgv, flag] : baseArgv).concat(paths.length ? ['--', ...paths] : []);

      const run = (argv: string[]) => git(ctx.cwd, argv, { signal: ctx.signal });
      const untrackedRes = args.staged
        ? null
        : await run(['ls-files', '--others', '--exclude-standard', ...(paths.length ? ['--', ...paths] : [])]).catch(
            (): null => null
          );
      const untracked = (untrackedRes?.stdout ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const [numstatRes, diffRes] = await Promise.all([run(withPaths('--numstat')), run(withPaths())]);
      if (numstatRes.exitCode !== 0) return fail(numstatRes.stderr || 'git diff --numstat failed');
      if (diffRes.exitCode !== 0) return fail(diffRes.stderr || 'git diff failed');
      const files = parseNumstat(numstatRes.stdout);

      const summary = files.length
        ? files.map((f) => `${f.binary ? '-' : f.added}\t${f.binary ? '-' : f.deleted}\t${f.path}`).join('\n')
        : '(no changes)';
      const body =
        [summary.trim() ? `${summary}\n\n${diffRes.stdout}`.trim() : diffRes.stdout, untracked.length && `[untracked, not in the diff]\n${untracked.map((f) => `  ${f}`).join('\n')}`]
          .filter(Boolean)
          .join('\n\n') || '(no changes)';

      const { text, truncated } = clamp(body, MAX_OUTPUT);
      return ok({
        kind: 'diff',
        display: text,
        truncated,
        data: {
          base: args.base ?? 'HEAD',
          target: args.target ?? null,
          staged: Boolean(args.staged),
          files,
          untracked,
        },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});