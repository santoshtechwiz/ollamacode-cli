import path from 'node:path';

import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { git, assertRepo, buildDiffArgv, parseNumstat } from './_git';

const COMMIT_TYPES = ['feat', 'fix', 'refactor', 'chore', 'docs', 'test', 'perf', 'build', 'ci'] as const;
type CommitType = (typeof COMMIT_TYPES)[number];

interface ProposedFile {
  path: string;
  status: string;
  added: number | null;
  deleted: number | null;
}

const BASE_NAME_RE = /^(?:src\/|lib\/|app\/|tests?\/|packages\/[^/]+\/)+/;
const TEST_RE = /(^|\/)(tests?|__tests__|spec|test)(\/|\.|$)|\.test\.|\.spec\.|_test\./i;
const DOC_RE = /\.(md|mdx|rst|adoc)$/i;
const MANIFEST_RE = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|pom\.xml|Pipfile|poetry\.lock)$/i;

function inferType(files: ProposedFile[]): CommitType {
  if (files.some((f) => TEST_RE.test(f.path))) return 'test';
  if (files.every((f) => DOC_RE.test(f.path))) return 'docs';
  if (files.some((f) => MANIFEST_RE.test(f.path))) return 'chore';
  const added = files.reduce((n, f) => n + (f.added ?? 0), 0);
  const deleted = files.reduce((n, f) => n + (f.deleted ?? 0), 0);
  if (files.some((f) => /^A/.test(f.status)) && added >= deleted) return 'feat';
  if (deleted > added) return 'fix';
  return 'feat';
}

function baseName(p: string): string {
  const base = path.basename(p).replace(/\.[^.]+$/, '');
  return BASE_NAME_RE.test(p) ? `${base}` : base;
}

function draftSummary(type: CommitType, files: ProposedFile[]): string {
  const names = [...new Set(files.map((f) => baseName(f.path)))].slice(0, 3);
  const verb =
    files.every((f) => f.added === null) && files.some((f) => /^D/.test(f.status))
      ? 'remove'
      : files.every((f) => f.deleted === 0 || f.deleted === null)
        ? 'add'
        : files.every((f) => f.added === 0 && f.deleted !== null && f.deleted > 0)
          ? 'remove'
          : 'update';
  return `${type}: ${verb} ${names.join(', ')}`;
}

export default defineTool({
  name: 'commit_message',
  profiles: ['core'],
  category: 'git',
  activity: 'Drafting a commit message',
  label: 'Commit Message',
  brief: 'Draft a conventional commit message from the staged changes.',
  description: `Draft a conventional commit message ("type: summary" plus a per-file body) from the currently staged changes.
Read-only: it proposes a message and never runs git commit. The summary is inferred from file names, not intent — reword it before committing.`,
  parameters: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: [...COMMIT_TYPES],
        description: 'Conventional commit type (default: inferred from the changed files)',
      },
    },
    required: [],
  },

  preview(args) {
    return args?.type ? `draft a ${args.type} commit message` : 'draft a commit message';
  },

  async execute(args, ctx) {
    try {
      await assertRepo(ctx.cwd, ctx.signal);
      const run = (argv: string[]) => git(ctx.cwd, argv, { signal: ctx.signal });
      const baseArgv = buildDiffArgv({ staged: true });

      const [numstatRes, nameStatusRes] = await Promise.all([run([...baseArgv, '--numstat']), run([...baseArgv, '--name-status'])]);
      if (numstatRes.exitCode !== 0) return fail(numstatRes.stderr || 'git diff --cached failed');
      if (nameStatusRes.exitCode !== 0) return fail(nameStatusRes.stderr || 'git diff --cached failed');

      const numstat = parseNumstat(numstatRes.stdout);
      if (numstat.length === 0) {
        return fail('Nothing is staged to commit.', {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Stage changes first with git add.',
        });
      }

      const statusByName = new Map<string, string>();
      for (const line of nameStatusRes.stdout.split('\n')) {
        if (!line.trim()) continue;
        const [status, ...rest] = line.split('\t');
        statusByName.set(rest.join('\t'), status ?? 'M');
      }
      const files: ProposedFile[] = numstat.map((f) => ({
        path: f.path,
        status: statusByName.get(f.path) ?? 'M',
        added: f.added,
        deleted: f.deleted,
      }));

      const type = (args.type as CommitType | undefined) ?? inferType(files);
      const summary = draftSummary(type, files);
      const body = files.map((f) => `- ${f.status} ${f.path}${f.added === null ? '' : ` (+${f.added}/-${f.deleted})`}`).join('\n');
      const message = `${summary}\n\n${body}`;

      return ok({
        kind: 'log',
        display: message,
        data: { type, summary, files, message },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});