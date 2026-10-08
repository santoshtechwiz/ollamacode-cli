import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { git, assertRepo, safeArg, parseStatus } from './_git';

interface FileEntry {
  path: string;
  status: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  renamedFrom?: string;
}

function renderStatusLine(f: FileEntry): string {
  const mark = f.untracked ? '?' : f.status;
  const from = f.renamedFrom ? ` (from ${f.renamedFrom})` : '';
  return `  ${mark} ${f.path}${from}`;
}

export default defineTool({
  name: 'changed_files',
  profiles: ['core', 'planning'],
  category: 'git',
  activity: 'Listing changed files',
  label: 'Changed Files',
  brief: 'List which files changed in the working tree, index, or since a commit.',
  description: `List the files changed in the workspace — unstaged, staged, untracked, or committed since a given ref — as a compact per-file status summary.
Do not show the changes themselves; use diff for that.`,
  parameters: {
    type: 'object',
    properties: {
      base: {
        type: 'string',
        description: 'Compare committed changes since this ref instead of the working tree (e.g. HEAD~1, main)',
      },
    },
    required: [],
  },

  preview(args) {
    return args?.base ? `git diff ${args.base} HEAD --name-status` : 'git status --short';
  },

  async execute(args, ctx) {
    try {
      await assertRepo(ctx.cwd, ctx.signal);
      const run = (argv: string[]) => git(ctx.cwd, argv, { signal: ctx.signal });

      if (args.base) {
        const ref = safeArg(args.base, 'base');
        const out = await run(['diff', '--name-status', ref, 'HEAD']);
        if (out.exitCode !== 0) return fail(out.stderr || 'git diff failed');
        const files: FileEntry[] = out.stdout
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [status, ...rest] = l.split('\t');
            const clean = (status ?? '').replace(/\d+$/, '').trim() || 'M';
            const isRename = clean.startsWith('R') && rest.length >= 2;
            return {
              path: isRename ? rest[rest.length - 1] : rest.join('\t'),
              status: clean,
              staged: true,
              unstaged: false,
              untracked: false,
              ...(isRename ? { renamedFrom: rest[rest.length - 2] } : {}),
            };
          });
        const byStatus = groupByStatus(files);
        const lines = files.map(renderStatusLine);
        return ok({
          kind: 'status',
          display: `${summaryLine(byStatus)}\n${lines.join('\n') || '  (no changes since this ref)'}`,
          data: { base: ref, files, summary: byStatus },
        });
      }

      const res = await run(['status', '--porcelain=v1', '-b', '--untracked-files=all']);
      if (res.exitCode !== 0) return fail(res.stderr || 'git status failed');
      const status = parseStatus(res.stdout);
      const files: FileEntry[] = status.files.map((f) => ({
        path: f.path,
        status: f.untracked ? '?' : [f.x, f.y].join('').trim() || 'M',
        staged: f.staged,
        unstaged: f.unstaged && !f.untracked,
        untracked: f.untracked,
        renamedFrom: f.renamedFrom,
      }));
      const byStatus = groupByStatus(files);
      const lines = files.map(renderStatusLine);
      return ok({
        kind: 'status',
        display: `${summaryLine(byStatus)}\n${lines.join('\n') || '  (no changes)'}`,
        data: { files, summary: byStatus },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

function groupByStatus(files: FileEntry[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const f of files) {
    const key = f.untracked
      ? 'untracked'
      : f.staged && f.unstaged
        ? 'modified'
        : f.status.includes('A')
          ? 'added'
          : f.status.includes('D')
            ? 'deleted'
            : f.status.includes('R')
              ? 'renamed'
              : 'modified';
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

function summaryLine(summary: Record<string, number>): string {
  const parts = Object.entries(summary).map(([k, v]) => `${v} ${k}`);
  return parts.length ? `${parts.join(', ')}` : 'no changes';
}