import { TOOL_ERROR_CODE, TOOL_RESULT_STATUS, STORAGE } from '../../protocol';
import { ToolError } from '../core/tool-error';
import { ok, fail, clamp } from '../core/tool-result';
import { runChild } from '../../env/process/index';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT = 20_000;

const BASE_ARGS = ['--no-pager', '-c', 'color.ui=false', '-c', 'core.quotepath=false'];

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface GitOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** The git context every helper here needs: where to run, and how to cancel. */
interface GitContext {
  cwd: string;
  signal?: AbortSignal;
  ws?: import('../../agent/workspace/manager.ts').Workspace;
}

export function git(cwd: string, argv: string[], { timeoutMs = DEFAULT_TIMEOUT_MS, signal }: GitOptions = {}): Promise<GitResult> {
  return runChild({
    file: 'git',
    args: [...BASE_ARGS, ...argv],
    options: {
      cwd,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0', // never block waiting for credentials
        GIT_PAGER: 'cat',
      },
    },
    timeoutMs,
    signal,
  }).then((out) => {
    if (out.spawnError) {
      const err = out.spawnError as NodeJS.ErrnoException;
      throw new ToolError(
        err.code === 'ENOENT'
          ? 'git is not installed or not on PATH'
          : `Failed to run git: ${err.message}`,
        { code: TOOL_ERROR_CODE.EUNKNOWN }
      );
    }
    if (out.timedOut) {
      throw new ToolError(`git ${argv[0]} timed out after ${timeoutMs}ms`, { code: TOOL_ERROR_CODE.ETIMEDOUT });
    }
    if (out.cancelled) {
      throw new ToolError(`git ${argv[0]} was cancelled`, { code: TOOL_ERROR_CODE.ECANCELLED });
    }
    const exitCode = out.exitCode ?? (out.signal ? 137 : null);
    if (exitCode === null) {
      throw new ToolError('git exited without reporting an exit code', { code: TOOL_ERROR_CODE.EEXIT });
    }
    return {
      exitCode,
      stdout: out.stdout,
      stderr: out.stderr.trim(),
    };
  });
}

export async function assertRepo(cwd: string, signal?: AbortSignal) {
  const res = await git(cwd, ['rev-parse', '--is-inside-work-tree'], { signal });
  if (res.exitCode !== 0 || res.stdout.trim() !== 'true') {
    throw new ToolError('Not a git repository', {
      code: TOOL_ERROR_CODE.ENOTREPO,
      // Creating a repository is the person's choice: the model says what it found instead of making one.
      hint: 'Tell the user this folder is not a git repository; create one (init, in the project folder) only if they ask for it. If the project is a subfolder that has its own repository, pass that folder as cwd.',
    });
  }
}

/** Git dirs already carrying our own-records exclusion this process. */
const EXCLUDED_GITDIRS = new Set<string>();

/** Hide the CLI's own records from git via .git/info/exclude (local-only); already-tracked ones are left in the index. */
export async function ensureOwnExclude(cwd: string, signal?: AbortSignal): Promise<void> {
  let dir: string;
  try {
    const res = await git(cwd, ['rev-parse', '--absolute-git-dir'], { signal });
    if (res.exitCode !== 0) return;
    dir = res.stdout.trim();
    if (!dir) return;
  } catch {
    return;
  }
  if (EXCLUDED_GITDIRS.has(dir)) return;
  EXCLUDED_GITDIRS.add(dir);
  // ocode's own folder: its session records and its workspace index (a SQLite file that changes as files do).
  try {
    const excludeFile = path.join(dir, 'info', 'exclude');
    fs.mkdirSync(path.join(dir, 'info'), { recursive: true });
    for (const own of [STORAGE.PROJECT_DIR]) {
      const current = fs.existsSync(excludeFile) ? fs.readFileSync(excludeFile, 'utf-8') : '';
      if (current.split(/\r?\n/).some((l) => l.trim() === `${own}/` || l.trim() === own)) continue;
      fs.appendFileSync(excludeFile, current.endsWith('\n') || current === '' ? `${own}/\n` : `\n${own}/\n`);
    }
  } catch {
  }
}

/** Session records and ledgers: machine noise, never user work. */
function isOwnRecord(filePath: string): boolean {
  const p = String(filePath ?? '');
  return p === STORAGE.PROJECT_DIR || p.startsWith(`${STORAGE.PROJECT_DIR}/`);
}

interface StatusFile {
  x: string;
  y: string;
  path: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  renamedFrom?: string;
}

function parseStatus(stdout: string) {
  const lines = stdout.split('\n').filter(Boolean);
  const branchInfo: { ahead: number; behind: number; branch?: string; upstream?: string; } = { ahead: 0, behind: 0 };
  const files: StatusFile[] = [];

  for (const line of lines) {
    if (line.startsWith('## ')) {
      const body = line.slice(3);
      const [names, tracking] = body.split(/\s+\[/);
      const [local, upstream] = names.split('...');
      branchInfo.branch = local === 'HEAD (no branch)' ? 'HEAD (detached)' : local;
      if (upstream) branchInfo.upstream = upstream;
      if (tracking) {
        const ahead = tracking.match(/ahead (\d+)/);
        const behind = tracking.match(/behind (\d+)/);
        if (ahead) branchInfo.ahead = Number(ahead[1]);
        if (behind) branchInfo.behind = Number(behind[1]);
      }
      continue;
    }
    const x = line[0];
    const y = line[1];
    let rest = line.slice(3);
    let renamedFrom;
    if (rest.includes(' -> ')) {
      const [from, to] = rest.split(' -> ');
      renamedFrom = from;
      rest = to;
    }
    files.push({
      x,
      y,
      path: rest,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ' && y !== '?',
      untracked: x === '?' && y === '?',
      renamedFrom,
    });
  }
  return { ...branchInfo, files };
}

function renderStatus(status: ReturnType<typeof parseStatus>) {
  const head = [
    `branch: ${status.branch ?? '(unknown)'}`,
    status.upstream ? `upstream: ${status.upstream}` : null,
    status.ahead ? `ahead ${status.ahead}` : null,
    status.behind ? `behind ${status.behind}` : null,
  ]
    .filter(Boolean)
    .join('  ');

  if (status.files.length === 0) return `${head}\nworking tree clean`;

  const staged = status.files.filter((f) => f.staged).map((f) => `  ${f.x} ${f.path}`);
  const unstaged = status.files.filter((f) => f.unstaged && !f.untracked).map((f) => `  ${f.y} ${f.path}`);
  const untracked = status.files.filter((f) => f.untracked).map((f) => `  ? ${f.path}`);

  return [
    head,
    staged.length ? `staged:\n${staged.join('\n')}` : null,
    unstaged.length ? `not staged:\n${unstaged.join('\n')}` : null,
    untracked.length ? `untracked:\n${untracked.join('\n')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export function safeArg(value: unknown, label: string): string {
  const s = String(value ?? '');
  if (s.startsWith('-')) {
    throw new ToolError(`${label} may not start with "-": ${s}`, { code: TOOL_ERROR_CODE.EINVAL });
  }
  return s;
}

export async function runStatus(ctx: GitContext): Promise<import('../../types.ts').ToolResult> {
  await assertRepo(ctx.cwd, ctx.signal);
  const res = await git(ctx.cwd, ['status', '--porcelain=v1', '-b', '--untracked-files=all'], {
    signal: ctx.signal,
  });
  if (res.exitCode !== 0) return fail(res.stderr || 'git status failed');
  const status = parseStatus(res.stdout);
  // Already-tracked session records are the user's index, not ours to rewrite — but they are still machine noise, so they stay out of what the model reads.
  const hidden = status.files.filter((f) => isOwnRecord(f.path));
  const shown = status.files.filter((f) => !isOwnRecord(f.path));
  const display = renderStatus({ ...status, files: shown });
  const note = hidden.length ? `\n(${hidden.length} own-record file(s) under ${STORAGE.PROJECT_DIR}/ hidden)` : '';
  return ok({ kind: 'status', display: `${display}${note}`, data: { ...status, files: shown, hidden: hidden.length } });
}

/** Split a space-separated `paths` argument and contain each one to the workspace. */
export async function containPaths(ctx: GitContext, pathsArg: unknown): Promise<string[]> {
  const parts = String(pathsArg ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => safeArg(p, 'path'));
  const ws = ctx?.ws;
  if (!ws) return parts;
  // Paths are given workspace-relative, like every tool's; git reads them relative to the repository it runs in.
  return Promise.all(parts.map(async (p) => path.relative(ctx.cwd, await ws.resolve(p)).split(path.sep).join('/') || '.'));
}

interface DiffOptions {
  staged?: boolean;
  ref?: string;
  paths?: unknown;
}

interface DiffArgvOptions {
  staged?: boolean;
  ref?: string;
  base?: string;
  target?: string;
  context?: number;
}

/** Shared git diff argv; the pathspec -- is added by callers so flags like --stat can come before it. */
function buildDiffArgv({ staged, ref, base, target, context = 3 }: DiffArgvOptions = {}): string[] {
  const argv = ['diff'];
  if (staged) argv.push('--cached');
  const width = Number(context) > 0 ? Math.min(Math.floor(Number(context)), 10) : 3;
  if (width !== 3) argv.push(`-U${width}`);
  const refArg = ref ?? base;
  if (refArg) argv.push(safeArg(refArg, 'ref'));
  if (target) argv.push(safeArg(target, 'target'));
  return argv;
}

export async function runDiff(ctx: GitContext, { staged, ref, paths: pathsArg }: DiffOptions = {}): Promise<import('../../types.ts').ToolResult> {
  await assertRepo(ctx.cwd, ctx.signal);
  const paths = await containPaths(ctx, pathsArg);

  const run = (argv: string[]) => git(ctx.cwd, argv, { signal: ctx.signal });
  const baseArgv = buildDiffArgv({ staged, ref });
  const withPaths = (flag?: string) => (flag ? [...baseArgv, flag] : baseArgv).concat(paths.length ? ['--', ...paths] : []);

  const untrackedRes = staged
    ? null
    : await run(['ls-files', '--others', '--exclude-standard', ...(paths.length ? ['--', ...paths] : [])]).catch(
        (): null => null
      );
  const untracked = (untrackedRes?.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const [statRes, diffRes] = await Promise.all([run(withPaths('--stat')), run(withPaths())]);
  if (statRes.exitCode !== 0) return fail(statRes.stderr || 'git diff --stat failed');
  if (diffRes.exitCode !== 0) return fail(diffRes.stderr || 'git diff failed');
  const tracked = `${statRes.stdout.trim()}\n\n${diffRes.stdout}`.trim();
  const body =
    [tracked, untracked.length && `[untracked, not in the diff]\n${untracked.map((f) => `  ${f}`).join('\n')}`]
      .filter(Boolean)
      .join('\n\n') || '(no changes)';

  const { text, truncated } = clamp(body, MAX_OUTPUT);
  return ok({
    kind: 'diff',
    display: text,
    truncated,
    data: { staged: Boolean(staged), stat: statRes.stdout.trim(), untracked },
  });
}

/** Post-mutation verification (§14 of the hardening plan): a mutating git operation is not reported as done on the strength of its exit code. */

interface PendingProof {
  status?: ReturnType<typeof parseStatus>;
  head?: string;
  branch?: string;
  stashCount?: number;
}

interface GitStateOptions {
  status?: boolean;
  head?: boolean;
  branch?: boolean;
  stash?: boolean;
  /** `--untracked-files` mode for the status probe. */
  untracked?: boolean;
}

export async function readGitState(ctx: GitContext, { status = false, head = false, branch = false, stash = false, untracked = true }: GitStateOptions = {}): Promise<PendingProof> {
  const [statusRes, headRes, branchRes, stashRes] = await Promise.all([
    status
      ? git(ctx.cwd, ['status', '--porcelain=v1', untracked ? '--untracked-files=all' : '--untracked-files=no'], { signal: ctx.signal })
      : null,
    head ? git(ctx.cwd, ['rev-parse', 'HEAD'], { signal: ctx.signal }) : null,
    branch ? git(ctx.cwd, ['rev-parse', '--abbrev-ref', 'HEAD'], { signal: ctx.signal }) : null,
    stash ? git(ctx.cwd, ['stash', 'list'], { signal: ctx.signal }) : null,
  ]);
  const ok = (res: GitResult | null | undefined) => res?.exitCode === 0;
  return {
    ...(status && ok(statusRes) ? { status: parseStatus(statusRes!.stdout) } : {}),
    ...(head && ok(headRes) ? { head: headRes!.stdout.trim() } : {}),
    ...(branch && ok(branchRes) && branchRes!.stdout.trim() !== 'HEAD'
      ? { branch: branchRes!.stdout.trim() }
      : {}),
    ...(stash && ok(stashRes) ? { stashCount: stashRes!.stdout.split('\n').filter(Boolean).length } : {}),
  };
}

/** The verdict on one claimed outcome, with the evidence the repo actually shows. */
export type Verification =
  | { ok: true; note?: string; proof: string }
  | { ok: false; contradiction: string; proof: string };

function statusLines(files: StatusFile[]): string {
  if (!files.length) return 'working tree clean';
  return files
    .map((f) => `${f.staged ? f.x : ' '}${f.untracked ? '?' : f.unstaged ? f.y : ' '} ${f.path}${f.renamedFrom ? ` (from ${f.renamedFrom})` : ''}`)
    .join('\n');
}

/** Every named path must be staged — an absent path means "nothing to stage", not a contradiction. */
export function verifyStaged(files: StatusFile[], paths: string[]): Verification {
  const matches = (requested: string, actual: string) => {
    const normalized = requested.replace(/\/+$/, '');
    return normalized === '.' || actual === normalized || actual.startsWith(`${normalized}/`);
  };
  const stillDirty = paths.filter((p) => {
    const entry = files.find((f) => matches(p, f.path));
    return entry && !entry.staged;
  });
  const untouched = paths.filter((p) => !files.some((f) => matches(p, f.path)));
  const proof = statusLines(files);
  if (stillDirty.length) {
    return { ok: false, contradiction: `never staged: ${stillDirty.join(', ')}`, proof };
  }
  return { ok: true, note: untouched.length ? `no changes to stage: ${untouched.join(', ')}` : undefined, proof };
}

/** `git add -A` leaves no unstaged or untracked non-ignored entry behind. */
export function verifyAllStaged(files: StatusFile[]): Verification {
  const notStaged = files.filter((f) => !f.staged);
  const proof = statusLines(files);
  if (notStaged.length) return { ok: false, contradiction: `not staged: ${notStaged.map((f) => f.path).join(', ')}`, proof };
  return { ok: true, note: files.length ? undefined : 'the tree was already clean — nothing to stage', proof };
}

/** After a stash push the tracked tree is clean; untracked files legitimately remain. */
export function verifyTrackedClean(files: StatusFile[]): Verification {
  const proof = statusLines(files);
  if (files.length) return { ok: false, contradiction: `still changed: ${statusLines(files)}`, proof };
  return { ok: true, proof };
}

/** After a mixed reset / restore --staged, the named paths are no longer staged. */
export function verifyUnstaged(files: StatusFile[], paths: string[]): Verification {
  const stillStaged = paths.length
    ? paths.filter((p) => files.find((f) => f.path === p && f.staged))
    : files.filter((f) => f.staged).map((f) => f.path);
  const proof = statusLines(files);
  if (stillStaged.length) return { ok: false, contradiction: `still staged: ${stillStaged.join(', ')}`, proof };
  return { ok: true, note: paths.length ? undefined : 'the index is empty', proof };
}

/** After a worktree restore, no named path may still hold an unstaged/untracked change. */
export function verifyWorktreeMatches(files: StatusFile[], paths: string[]): Verification {
  const stillDirty = paths.filter((p) => {
    const entry = files.find((f) => f.path === p);
    return entry?.unstaged || entry?.untracked;
  });
  const proof = statusLines(files);
  if (stillDirty.length) return { ok: false, contradiction: `still modified in the working tree: ${stillDirty.join(', ')}`, proof };
  return { ok: true, proof };
}

/** commit/merge must have moved HEAD, or nothing was recorded. */
export function verifyHeadMoved(before: string | undefined, after: string | undefined, { firstCommit = false } = {}): Verification {
  const proof = `HEAD ${before ?? '(none)'} -> ${after ?? '(none)'}`;
  // A first commit has no HEAD before it: the caller shows the new HEAD has no parent, and that is the proof.
  // Otherwise a HEAD that could not be read before proves nothing.
  if (!after || before === after || (!before && !firstCommit)) {
    return { ok: false, contradiction: 'HEAD did not move', proof };
  }
  return { ok: true, ...(before ? {} : { note: 'first commit in this repository' }), proof };
}

/** Checkout switched to the target branch, or detached HEAD resolves to its commit. */
export function verifyCheckout(
  branch: string | undefined,
  head: string | undefined,
  expectedBranch: string,
  expectedHead?: string,
): Verification {
  const proof = `branch: ${branch ?? '(detached HEAD)'}\nHEAD: ${head ?? '(unknown)'}`;
  if (branch === expectedBranch) return { ok: true, proof };
  if (expectedHead && head === expectedHead) return { ok: true, note: 'detached HEAD verified by commit', proof };
  return { ok: false, contradiction: `HEAD is on ${branch ?? '(detached)'}, not ${expectedBranch}`, proof };
}

export function verifyStashDelta(before: number | undefined, after: number | undefined, expectedDelta: number): Verification {
  const proof = `stash entries ${before ?? '(none)'} -> ${after ?? '(none)'}`;
  if (before === undefined || after === undefined || after !== before + expectedDelta) {
    return { ok: false, contradiction: `expected ${expectedDelta >= 0 ? '+' : ''}${expectedDelta} entry`, proof };
  }
  return { ok: true, proof };
}

/** Package a verification: SUCCESS with the proof attached, or NOT_VERIFIED when the claim contradicts it. */
export function verifiedResult(operation: string, claim: string, v: Verification, data: Record<string, unknown>): import('../../types.ts').ToolResult {
  if (v.ok === true) {
    return ok({
      kind: 'status',
      display: [claim, v.note, v.proof].filter(Boolean).join('\n'),
      data: { ...data, verified: true, proof: v.proof },
    });
  }
  return fail(`${operation}: claimed "${claim}", but the repository shows otherwise — ${v.contradiction}.`, {
    code: TOOL_ERROR_CODE.ENOTVERIFIED,
    status: TOOL_RESULT_STATUS.NOT_VERIFIED,
    display: `Claimed: ${claim}\n\nRepository state:\n${v.proof}`,
    hint: 'Describe what actually happened and what you verified, not the intended outcome.',
    data: { ...data, verified: false, proof: v.proof },
  });
}

