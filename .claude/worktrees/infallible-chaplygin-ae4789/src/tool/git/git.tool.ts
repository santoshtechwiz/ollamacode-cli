import fs from 'node:fs';
import path from 'node:path';
import { isProjectMarker } from '../../env/languages';
import { workingProject } from '../../context/workspace-state';
import { isInside } from '../core/paths';
import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError, clamp } from '../core/tool-result';
import {
  git,
  assertRepo,
  ensureOwnExclude,
  safeArg,
  runStatus,
  runDiff,
  containPaths,
  readGitState,
  verifiedResult,
  verifyStaged,
  verifyAllStaged,
  verifyTrackedClean,
  verifyUnstaged,
  verifyWorktreeMatches,
  verifyHeadMoved,
  verifyCheckout,
  verifyStashDelta,
} from './_git';
import type { Verification } from './_git';
import { GIT_WRITE_OPS as WRITE_OPS } from '../policy/mutation-policy';
import { resolveCallCwd } from '../process/shell/runtime';

const MAX_OUTPUT = 20_000;

// Declared once as a tuple so the schema enum, the guard below and the switch cannot drift apart: adding an operation here makes TypeScript demand a case.
const OPERATIONS = [
  'init', 'status', 'diff', 'log', 'show', 'branch', 'checkout',
  'add', 'commit', 'merge', 'stash', 'restore', 'reset', 'blame',
] as const;

type GitOperation = (typeof OPERATIONS)[number];

const STASH_SUBCOMMANDS = ['push', 'pop', 'list', 'apply', 'drop'];

/** The folder an init would make a repository of, named so the person can tell the workspace root from a project. */
function initFolder(args: Record<string, unknown> | undefined, where?: { cwd?: string; root?: string; state?: any }): string {
  const root = path.resolve(where?.root ?? where?.cwd ?? '.');
  // The folder the call will run in: the one given, else the working project, else the workspace root.
  const target = args?.cwd ? path.resolve(root, String(args.cwd)) : path.resolve(workingProject(where?.state ? { ...where.state, root } : null) ?? root);
  const named = target === root ? `the workspace root (${target})` : target;
  // A folder that is no project but holds projects is usually the wrong place: one repository would track them all.
  const projects = projectsInside(target);
  const enclosing = repositoryAbove(target, root);
  if (enclosing) return `${named}, inside the existing repository at ${enclosing}: a second repository nested in it, which that one then stops tracking`;
  return projects.length
    ? `${named}, which is not a project itself but holds ${projects.join(', ')}: one repository would track them all together`
    : `${named}; everything under that folder can then be tracked`;
}

/** The nearest folder above `dir`, up to `root`, that is already a git repository; null when none is. */
function repositoryAbove(dir: string, root: string): string | null {
  let probe = path.dirname(dir);
  while (isInside(root, probe)) {
    if (fs.existsSync(path.join(probe, '.git'))) return probe;
    if (isInside(probe, root)) break;
    probe = path.dirname(probe);
  }
  return null;
}

/** The subfolders of a folder that is no project itself which are projects (hold a project marker), named with a slash. */
function projectsInside(dir: string): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && isProjectMarker(e.name))) return [];
    const found = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .filter((e) => { try { return fs.readdirSync(path.join(dir, e.name)).some((n) => isProjectMarker(n)); } catch { return false; } })
      .map((e) => `${e.name}/`);
    return found.length > 5 ? [...found.slice(0, 5), `${found.length - 5} more`] : found;
  } catch {
    return [];
  }
}

export default defineTool({
  name: 'git',
  argAliases: {
    op: 'operation',
    action: 'operation',
    command: 'operation',
    cmd: 'operation',
    tool: 'operation',
    msg: 'message',
    path: 'paths',
    file: 'paths',
    branch: 'name',
  },
  profiles: ['core', 'planning'],
  category: 'git',
  activity: 'Running git',
  label: 'Git',
  risky: true,
  description:
    'Run a git operation: status, diff, log, show, branch, checkout, add, commit, merge, stash, restore, reset, blame. ' +
    'checkout takes one target (name or ref) to switch, or create with name plus ref to create the branch at that start point. ' +
    'branch deletes with delete: true (safe -d only: git itself refuses unmerged work).',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', description: 'Operation to perform', enum: [...OPERATIONS] },
      cwd: { type: 'string', pathArg: true, description: 'Workspace-relative folder of the repository to work in, e.g. the project folder; leave it out for the working project (see the session record), or the workspace root when there is none. paths stay workspace-relative.' },
      paths: { type: 'string', description: 'Space-separated paths (add, restore, diff, blame)' },
      message: { type: 'string', description: 'Commit message (commit)' },
      ref: { type: 'string', description: 'Branch, tag or commit (checkout, show, merge, log)' },
      name: { type: 'string', description: 'Branch name (branch, checkout)' },
      delete: { type: 'boolean', description: 'Delete the branch instead of creating it (branch; safe -d only)' },
      create: { type: 'boolean', description: 'Create the branch (checkout)' },
      staged: { type: 'boolean', description: 'Show staged changes instead of unstaged (diff)' },
      limit: { type: 'number', description: 'Number of entries (log, default 20)' },
      all: { type: 'boolean', description: 'Stage every change (add), or list all branches' },
      subcommand: { type: 'string', description: 'push/pop/list for stash' },
    },
    required: ['operation'],
  },

  isRisky(args) {
    const op = String(args?.operation ?? '').toLowerCase();
    if (op === 'branch') return Boolean(args?.name) || Boolean(args?.delete);
    if (op === 'stash') return String(args?.subcommand ?? 'push').toLowerCase() !== 'list';
    return WRITE_OPS.has(op);
  },

  // Unstaged restore and stash drop destroy work permanently, so they always confirm; --yes and always never cover them.
  // Staging, committing, switching, stashing and unstaging are routine: an always-allow covers them. A merge rewrites
  // the branch and its files, and a branch delete is a delete, so those are asked about every time.
  confirmReason(args, where) {
    const op = String(args?.operation ?? '').toLowerCase();
    if (op === 'merge') return 'rewrites the branch and the files in it';
    // Where a repository goes decides what it tracks: the person sees the folder and says yes every time.
    if (op === 'init') return `creates a git repository in ${initFolder(args, where)}`;
    if (op === 'branch' && args?.delete) return 'deletes a branch';
    return null;
  },

  dangerReason(args) {
    const op = String(args?.operation ?? '').toLowerCase();
    if (op === 'restore' && args?.staged !== true) return 'git restore discards uncommitted working-tree changes permanently';
    if (op === 'stash' && String(args?.subcommand ?? 'push').toLowerCase() === 'drop') return 'git stash drop destroys the stashed work permanently';
    return null;
  },

  preview(args) {
    const op = String(args?.operation ?? '');
    if (op === 'branch' && args?.delete) return `git branch -d ${args?.name ?? ''}`;
    if (op === 'commit') return `git commit -m ${JSON.stringify(String(args?.message ?? '').slice(0, 80))}`;
    if (op === 'add') return `git add ${args?.all ? '-A' : String(args?.paths ?? '')}`;
    if (op === 'init') return args?.cwd ? `git init in ${String(args.cwd)}` : 'git init';
    if (op === 'checkout') {
      const base = `git checkout ${args?.create ? '-b ' : ''}${args?.name ?? args?.ref ?? ''}`;
      return args?.create && args?.ref ? `${base} ${args.ref}` : base;
    }
    return `git ${op}`;
  },

  async execute(args, ctx) {
    const operation = String(args.operation ?? '').toLowerCase() as GitOperation;
    if (!(OPERATIONS as readonly string[]).includes(operation)) {
      return fail(`Unknown git operation "${operation}". Use one of: ${OPERATIONS.join(', ')}`, {
        code: TOOL_ERROR_CODE.EINVAL,
      });
    }

    // A project in a subfolder is its own repository: the call runs there — the folder given, else the working project
    // when the workspace root is no project itself (resolveCallCwd decides, as for shell commands).
    {
      const where = await resolveCallCwd(args, ctx);
      if (where.result) return where.result;
      ctx = { ...ctx, cwd: where.cwd };
    }

    if (operation === 'init') {
      const res = await git(ctx.cwd, ['init'], { signal: ctx.signal });
      if (res.exitCode !== 0) return fail(res.stderr || 'git init failed');
      await ensureOwnExclude(ctx.cwd, ctx.signal);
      return ok({ kind: 'status', display: res.stdout.trim() || `Initialized a git repository in ${ctx.cwd}`, data: { cwd: ctx.cwd } });
    }

    try {
      await assertRepo(ctx.cwd, ctx.signal);
      // Our own session records must never pollute this repository's status or block its branch switches.
      await ensureOwnExclude(ctx.cwd, ctx.signal);
      const paths = await containPaths(ctx, args.paths);

      const run = (argv: string[]) => git(ctx.cwd, argv, { signal: ctx.signal });
      // git takes paths relative to the folder it runs in, but status names them from the repository's top, which can
      // sit above that folder: the checks compare the paths as status spells them.
      const repoPaths = async () => {
        const prefix = (await run(['rev-parse', '--show-prefix'])).stdout.trim();
        return paths.map((p) => path.posix.normalize(`${prefix}${p}`).replace(/\/+$/, '') || '.');
      };
      /** Run, or return the failure git reported — the shape every case repeats. */
      const runOrFail = async (argv: string[], label: string) => {
        const res = await run(argv);
        return res.exitCode === 0 ? { res } : { failure: fail(res.stderr || `${label} failed`) };
      };

      switch (operation) {
        case 'status':
          return runStatus(ctx);

        case 'diff':
          return runDiff(ctx, { staged: args.staged, ref: args.ref, paths: args.paths });

        case 'log': {
          const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 200) : 20;
          const argv = ['log', `-${limit}`, '--date=short', '--pretty=format:%h|%ad|%an|%s'];
          if (args.ref) argv.push(safeArg(args.ref, 'ref'));
          if (paths.length) argv.push('--', ...paths);
          const out = await runOrFail(argv, 'git log');
          if (out.failure) return out.failure;
          const res = out.res;
          const commits = res.stdout
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              const [hash, date, author, ...rest] = l.split('|');
              return { hash, date, author, subject: rest.join('|') };
            });
          return ok({
            kind: 'log',
            display: commits.map((c) => `${c.hash} ${c.date} ${c.author}: ${c.subject}`).join('\n') || '(no commits)',
            data: { commits },
          });
        }

        case 'show': {
          const out = await runOrFail(['show', '--stat', '--patch', safeArg(args.ref ?? 'HEAD', 'ref')], 'git show');
          if (out.failure) return out.failure;
          const res = out.res;
          const { text, truncated } = clamp(res.stdout, MAX_OUTPUT);
          return ok({ kind: 'diff', display: text, truncated, data: { ref: args.ref ?? 'HEAD' } });
        }

        case 'blame': {
          if (!paths.length) return fail('blame requires paths', { code: TOOL_ERROR_CODE.EINVAL });
          const out = await runOrFail(['blame', '--line-porcelain', '--', paths[0]], 'git blame');
          if (out.failure) return out.failure;
          const res = out.res;
          const { text, truncated } = clamp(res.stdout, MAX_OUTPUT);
          return ok({ kind: 'text', display: text, truncated, data: { path: paths[0] } });
        }

        case 'branch': {
          if (args.delete) {
            // Safe delete only (-d): git itself refuses a branch with unmerged work or the checked-out branch, so the tool cannot be talked into data loss.
            if (!args.name) return fail('branch delete requires "name"', { code: TOOL_ERROR_CODE.EINVAL });
            const removed = await runOrFail(['branch', '-d', safeArg(args.name, 'branch name')], 'git branch');
            if (removed.failure) return removed.failure;
            const ref = await run(['show-ref', '--verify', `refs/heads/${args.name}`]);
            const gone = ref.exitCode !== 0;
            return verifiedResult('git branch', `Deleted branch ${args.name}`, {
              ok: gone,
              proof: `refs/heads/${args.name} ${gone ? 'gone' : 'still present'}`,
              ...(gone ? {} : { contradiction: 'the branch ref is still present' }),
            } as Verification, { name: args.name, delete: true });
          }
          if (args.name) {
            const created = await runOrFail(['branch', safeArg(args.name, 'branch name')], 'git branch');
            if (created.failure) return created.failure;
            const ref = await run(['show-ref', '--verify', `refs/heads/${args.name}`]);
            const exists = ref.exitCode === 0;
            return verifiedResult('git branch', `Created branch ${args.name}`, {
              ok: exists,
              proof: `refs/heads/${args.name} ${exists ? 'exists' : 'not found'}`,
              ...(exists ? {} : { contradiction: 'the branch ref is not present' }),
            } as Verification, { name: args.name });
          }
          const out = await runOrFail(['branch', ...(args.all ? ['-a'] : []), '--format=%(refname:short)%(if)%(HEAD)%(then) *%(end)'], 'git branch');
          if (out.failure) return out.failure;
          const res = out.res;
          const branches = res.stdout.split('\n').filter(Boolean);
          return ok({ kind: 'status', display: branches.join('\n'), data: { branches } });
        }

        case 'checkout': {
          const name = args.name ? String(args.name) : '';
          const ref = args.ref ? String(args.ref) : '';
          if (!name && !ref) return fail('checkout requires "name" or "ref"', { code: TOOL_ERROR_CODE.EINVAL });
          // A switch takes exactly one target; a start point needs create: true.
          if (name && ref && !args.create && name !== ref) {
            return fail(`checkout got both a branch ${JSON.stringify(name)} and a ref ${JSON.stringify(ref)} — pass one to switch, or add create: true to create ${JSON.stringify(name)} at ${JSON.stringify(ref)}`, {
              code: TOOL_ERROR_CODE.EINVAL,
            });
          }
          const target = safeArg(name || ref, 'branch');
          const startPoint = args.create && ref ? safeArg(ref, 'ref') : null;
          // Pin a relative start point (HEAD~3) before the checkout moves HEAD.
          let expectedStart: string | null = null;
          let expectedTarget: string | null = null;
          if (startPoint) {
            const want = await run(['rev-parse', '--verify', `${startPoint}^{commit}`]);
            expectedStart = want.exitCode === 0 ? want.stdout.trim() : null;
            if (!expectedStart) {
              return fail(`start point ${JSON.stringify(ref)} does not resolve to a commit`, {
                code: TOOL_ERROR_CODE.EINVAL,
                hint: 'Use git log to find the intended commit hash first.',
              });
            }
          } else if (!args.create) {
            const want = await run(['rev-parse', '--verify', `${target}^{commit}`]);
            expectedTarget = want.exitCode === 0 ? want.stdout.trim() : null;
          }
          const res = await run(['checkout', ...(args.create ? ['-b'] : []), target, ...(startPoint ? [startPoint] : [])]);
          if (res.exitCode !== 0) {
            const detail = `${res.stdout}\n${res.stderr}`.trim();
            // A dirty tree blocks the switch; say to stash or commit first, or the model retries the same checkout.
            const dirty = /would be overwritten|stash them|commit your changes|unmerged/i.test(detail);
            return fail(detail || 'git checkout failed', dirty ? {
              hint: 'The working tree blocks this checkout: git stash push (or commit) first, then retry the checkout.',
            } : undefined);
          }
          const after = await readGitState(ctx, { branch: true, head: true });
          const v = verifyCheckout(after.branch, after.head, args.create ? name || target : target, expectedTarget ?? undefined);
          if (!v.ok) {
            return verifiedResult('git checkout', `Switched to ${target}`, v, { ref: target, created: Boolean(args.create), output: res.stderr || res.stdout.trim() });
          }
          // A branch created at a start point must actually start there: name verification alone once reported success a whole history away.
          if (startPoint) {
            if (after.head !== expectedStart) {
              return verifiedResult('git checkout', `Switched to ${target}`, {
                ok: false,
                contradiction: `the branch starts at ${after.head ?? '(unknown)'}, not ${ref} (${expectedStart})`,
                proof: `HEAD ${after.head ?? '(none)'}`,
              }, { ref: target, created: true, startPoint: ref, output: res.stderr || res.stdout.trim() });
            }
          }
          return verifiedResult(
            'git checkout',
            startPoint ? `Switched to ${target} at ${ref}` : `Switched to ${target}`,
            v,
            { ref: target, created: Boolean(args.create), ...(startPoint ? { startPoint: ref } : {}), output: res.stderr || res.stdout.trim() }
          );
        }

        case 'add': {
          if (!args.all && paths.length === 0) {
            return fail('git add needs paths, or all: true to stage everything', {
              code: TOOL_ERROR_CODE.EINVAL,
              hint: 'Staging the whole tree is a deliberate choice; say so explicitly.',
            });
          }
          const argv = args.all ? ['add', '-A'] : ['add', '--', ...paths];
          const staged = await runOrFail(argv, 'git add');
          if (staged.failure) return staged.failure;
          const after = await readGitState(ctx, { status: true });
          const files = after.status?.files ?? [];
          if (args.all) {
            const v = verifyAllStaged(files);
            return verifiedResult(
              'git add',
              v.ok ? (files.length ? `Staged all ${files.length} change${files.length === 1 ? '' : 's'}` : 'Nothing to stage — the tree is clean') : 'Staged every change',
              v,
              { all: true }
            );
          }
          const v = verifyStaged(files, await repoPaths());
          return verifiedResult(
            'git add',
            `Staged ${paths.join(', ')}`,
            v,
            { staged: paths }
          );
        }

        case 'commit': {
          const message = String(args.message ?? '').trim();
          if (!message) return fail('commit requires a message', { code: TOOL_ERROR_CODE.EINVAL });
          const before = await readGitState(ctx, { head: true });
          const res = await run(['commit', '-m', message]);
          if (res.exitCode !== 0) {
            const detail = `${res.stdout}\n${res.stderr}`.trim();
            if (/nothing to commit/i.test(detail)) {
              return fail('Nothing to commit', { code: TOOL_ERROR_CODE.EINVAL, hint: 'Stage changes with git add first.' });
            }
            return fail(detail || 'git commit failed');
          }
          const after = await readGitState(ctx, { head: true, status: true });
          const firstCommit = !before.head && Boolean(after.head) && (await run(['rev-parse', '--verify', '--quiet', 'HEAD^'])).exitCode !== 0;
          const v = verifyHeadMoved(before.head, after.head, { firstCommit });
          return verifiedResult('git commit', `Committed: ${res.stdout.trim()}`, v, {
            message,
            output: res.stdout.trim(),
          });
        }

        case 'merge': {
          const ref = safeArg(args.ref ?? args.name ?? '', 'ref');
          if (!ref) return fail('merge requires "ref"', { code: TOOL_ERROR_CODE.EINVAL });
          const before = await readGitState(ctx, { head: true });
          const res = await run(['merge', '--no-edit', ref]);
          const detail = `${res.stdout}\n${res.stderr}`.trim();
          if (res.exitCode !== 0) {
            const conflicts = [...detail.matchAll(/CONFLICT[^\n]*/g)].map((m) => m[0].trim());
            const conflictHint = conflicts.length
              ? `Conflicts: ${conflicts.join(' | ')}. Open each file, resolve the <<<<<<< / ======= / >>>>>>> markers, git add them, then commit.`
              : undefined;
            return fail(detail || 'git merge failed', {
              hint: /conflict/i.test(detail)
                ? conflictHint ?? 'Resolve conflicts, git add the files, then commit.'
                : undefined,
            });
          }
          const after = await readGitState(ctx, { head: true, status: true });
          const merged = (after.status?.files ?? []).filter((f) => f.x === 'U' || f.y === 'U' || (f.x === 'A' && f.y === 'A') || (f.x === 'D' && f.y === 'D'));
          const mergeProof = after.status?.files?.length
            ? after.status.files.map((f) => `${f.x}${f.y} ${f.path}`).join('\n')
            : 'working tree clean';
          if (!verifyHeadMoved(before.head, after.head).ok) {
            return verifiedResult('git merge', `Merged ${ref}`, { ok: false, contradiction: 'HEAD did not move', proof: after.head ?? '(none)' }, { ref });
          }
          if (merged.length) {
            return verifiedResult('git merge', `Merged ${ref}`, { ok: false, contradiction: `unresolved conflicts left: ${merged.map((f) => f.path).join(', ')}`, proof: mergeProof }, { ref });
          }
          return verifiedResult('git merge', `Merged ${ref}`, { ok: true, proof: mergeProof }, { ref });
        }

        case 'stash': {
          const sub = String(args.subcommand ?? 'push').toLowerCase();
          if (!STASH_SUBCOMMANDS.includes(sub)) {
            return fail(`Unknown stash subcommand "${sub}"`, { code: TOOL_ERROR_CODE.EINVAL });
          }
          if (sub === 'list') {
            const out = await runOrFail(['stash', 'list'], 'git stash');
            if (out.failure) return out.failure;
            const res = out.res;
            return ok({ kind: 'status', display: res.stdout.trim() || '(no stashes)', data: {} });
          }

          const before = await readGitState(ctx, { stash: true });
          const out = await runOrFail(['stash', sub, ...(sub === 'push' && args.message ? ['-m', String(args.message)] : [])], 'git stash');
          if (out.failure) return out.failure;
          const res = out.res;
          // stash push does not fold untracked files in, so the cleanliness it claims is about tracked changes only.
          const after = await readGitState(ctx, { stash: true, status: sub === 'push' || sub === 'apply', untracked: false });

          if (sub === 'push') {
            const v = verifyTrackedClean(after.status?.files ?? []);
            const grew = verifyStashDelta(before.stashCount, after.stashCount, +1);
            if (!v.ok) {
              return verifiedResult('git stash', 'Stashed the working tree', v, { subcommand: sub, output: res.stdout.trim() });
            }
            if (!grew.ok) {
              return verifiedResult('git stash', 'Stashed the working tree', { ok: false, contradiction: 'the stash list did not grow', proof: grew.proof }, { subcommand: sub, output: res.stdout.trim() });
            }
            return verifiedResult('git stash', 'Stashed the working tree', { ok: true, proof: `stash entries ${before.stashCount} -> ${after.stashCount}\nworking tree clean` }, { subcommand: sub, output: res.stdout.trim() });
          }

          if (sub === 'pop' || sub === 'drop') {
            const v = verifyStashDelta(before.stashCount, after.stashCount, -1);
            return verifiedResult('git stash', sub === 'pop' ? 'Restored the stashed changes' : 'Dropped the stash entry', v, { subcommand: sub, output: res.stdout.trim() });
          }

          // apply restores the changes without removing the entry: the evidence is the reappeared changes in the working tree.
          if ((after.status?.files?.length ?? 0) > 0) {
            return verifiedResult('git stash', 'Applied the stash', { ok: true, proof: (after.status?.files ?? []).map((f) => `${f.x}${f.y} ${f.path}`).join('\n') || 'working tree clean' }, { subcommand: sub, output: res.stdout.trim() });
          }
          return verifiedResult('git stash', 'Applied the stash', { ok: false, contradiction: 'the working tree shows no changes after apply', proof: 'working tree clean' }, { subcommand: sub, output: res.stdout.trim() });
        }

        case 'restore': {
          if (!paths.length) return fail('restore requires paths', { code: TOOL_ERROR_CODE.EINVAL });
          const restored = await runOrFail(['restore', ...(args.staged ? ['--staged'] : []), '--', ...paths], 'git restore');
          if (restored.failure) return restored.failure;
          const after = await readGitState(ctx, { status: true });
          const inRepo = await repoPaths();
          const v = args.staged ? verifyUnstaged(after.status?.files ?? [], inRepo) : verifyWorktreeMatches(after.status?.files ?? [], inRepo);
          return verifiedResult('git restore', args.staged ? `Unstaged ${paths.join(', ')}` : `Restored ${paths.join(', ')}`, v, { paths });
        }

        case 'reset': {
          const out = await runOrFail(['reset', ...(paths.length ? ['--', ...paths] : [])], 'git reset');
          if (out.failure) return out.failure;
          const res = out.res;
          const after = await readGitState(ctx, { status: true });
          const v = verifyUnstaged(after.status?.files ?? [], await repoPaths());
          return verifiedResult('git reset', paths.length ? `Unstaged ${paths.join(', ')}` : 'Unstaged every change', v, {
            paths,
            output: res.stdout.trim(),
          });
        }

        default:
          return fail(`Unhandled operation ${operation}`, { code: TOOL_ERROR_CODE.EINVAL });
      }
    } catch (err) {
      return fromError(err);
    }
  },
});

