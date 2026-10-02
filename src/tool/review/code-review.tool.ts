import fsp from 'node:fs/promises';
import path from 'node:path';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError, clamp } from '../core/tool-result';
import { TOOL_ERROR_CODE } from '../../protocol';
import { git, assertRepo, safeArg } from '../git/_git';
import { scanContent } from '../search/_search';
import { walkFiles } from '../filesystem/_fs';
import { lookupSymbol, type IndexHandle } from '../search/_symbols';
import { findDuplicateBlocks, COMPLEXITY_THRESHOLD, type Finding, type FunctionMetric, type DuplicateBlock } from './_analysis';
import { loadProject, findCycles, findUnused, analyzeFile, isReviewable, type Project } from './_graph';
import { isProjectMarker } from '../../env/languages';
import { detectTooling, runCheck, combineVerification, runKnip, runMadge, type CheckResult, type CheckKind } from './_tooling';

const OPERATIONS = [
  'review_changes',
  'review_file',
  'review_symbol',
  'find_references',
  'find_duplicates',
  'find_unused',
  'find_import_cycles',
  'analyze_complexity',
] as const;
type Operation = (typeof OPERATIONS)[number];

const MAX_DISPLAY = 20_000;
const MAX_LISTED = 60;
/** Outside git there is no diff to narrow to, so whole files are reviewed, up to this many. */
const MAX_UNTRACKED_REVIEW = 400;

const JUDGE_CHECKLIST =
  'Static checks cannot see everything. Read the diff and judge: regressions or broken existing behaviour, incorrect error handling, ' +
  'duplicated logic, unnecessary abstractions, dead code, type problems, async/concurrency issues, security/permission problems, ' +
  'performance problems, missing edge cases. Fix what is real, then report what remains.';

const toPosix = (p: string) => p.split(path.sep).join('/');

/** The checks a call asks for; only the two operations that review real files run them, so only they can ask for them. */
function checkKinds(args: Record<string, unknown> | undefined): CheckKind[] {
  const op = String(args?.operation ?? 'review_changes');
  if (op !== 'review_changes' && op !== 'review_file') return [];
  return [
    ...(args?.checks === true ? (['lint', 'typecheck'] as const) : []),
    ...(args?.tests === true || Boolean(args?.test_command) ? (['test'] as const) : []),
  ];
}

interface ChangedFile {
  rel: string;
  status: 'modified' | 'added' | 'deleted' | 'untracked';
  /** New-side line numbers that changed; null means the whole file is new. */
  lines: Set<number> | null;
}

/** Changed files under `root` with their changed line numbers: the working tree (plus untracked) against `base`, default HEAD. */
async function collectChanges(root: string, base: string | undefined, signal?: AbortSignal): Promise<ChangedFile[]> {
  await assertRepo(root, signal);
  const run = (argv: string[]) => git(root, argv, { signal });

  const hasHead = (await run(['rev-parse', '--verify', '--quiet', 'HEAD'])).exitCode === 0;
  const files = new Map<string, ChangedFile>();

  if (base || hasHead) {
    // --relative: git names files relative to root itself, so no path is rebuilt from the repo top, which can be
    // spelled differently from root (a Windows 8.3 short name, macOS /var vs /private/var) and drop every change.
    const diff = await run(['diff', '--relative', '-U0', '--no-color', '--no-ext-diff', base ? safeArg(base, 'base') : 'HEAD', '--', '.']);
    if (diff.exitCode !== 0) throw new Error(diff.stderr.trim() || 'git diff failed');
    let current: ChangedFile | null = null;
    let oldPath = '';
    for (const line of diff.stdout.split('\n')) {
      if (line.startsWith('--- ')) oldPath = line.slice(4);
      else if (line.startsWith('+++ ')) {
        const target = line.slice(4);
        current = target === '/dev/null'
          ? { rel: oldPath.replace(/^a\//, ''), status: 'deleted', lines: new Set() }
          : { rel: target.replace(/^b\//, ''), status: oldPath === '/dev/null' ? 'added' : 'modified', lines: new Set() };
        files.set(current.rel, current);
      } else if (line.startsWith('@@') && current?.lines) {
        const m = /\+(\d+)(?:,(\d+))?/.exec(line);
        if (!m) continue;
        const start = Number(m[1]);
        const count = m[2] === undefined ? 1 : Number(m[2]);
        for (let n = start; n < start + count; n++) current.lines.add(n);
      }
    }
  }

  // With no commit yet, everything tracked is new too.
  const listed = await run(['ls-files', '--others', ...(hasHead || base ? [] : ['--cached']), '--exclude-standard', '--', '.']);
  for (const repoPath of listed.stdout.split('\n').map((l) => l.trim()).filter(Boolean)) {
    // ls-files prints paths relative to the cwd it ran in, which is root.
    const rel = repoPath;
    if (!files.has(rel)) files.set(rel, { rel, status: 'untracked', lines: null });
  }
  return [...files.values()].sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Without git: every reviewable file under `scopeAbs` stands in for "the changes", each reviewed whole. */
async function collectAllFiles(root: string, scopeAbs: string, signal?: AbortSignal): Promise<{ files: ChangedFile[]; capped: boolean }> {
  const stat = await fsp.stat(scopeAbs).catch((): null => null);
  if (stat?.isFile()) return { files: [{ rel: toPosix(path.relative(root, scopeAbs)), status: 'untracked', lines: null }], capped: false };
  const files: ChangedFile[] = [];
  for await (const { abs } of walkFiles(scopeAbs, { signal })) {
    const rel = toPosix(path.relative(root, abs));
    if (!isReviewable(rel)) continue;
    if (files.length >= MAX_UNTRACKED_REVIEW) return { files, capped: true };
    files.push({ rel, status: 'untracked', lines: null });
  }
  return { files: files.sort((a, b) => a.rel.localeCompare(b.rel)), capped: false };
}

function touchesLines(change: ChangedFile | undefined, start: number, end: number): boolean {
  if (!change) return false;
  if (!change.lines) return true;
  for (let n = start; n <= end; n++) if (change.lines.has(n)) return true;
  return false;
}

function changedShare(change: ChangedFile, start: number, end: number): number {
  if (!change.lines) return 1;
  let hit = 0;
  for (let n = start; n <= end; n++) if (change.lines.has(n)) hit += 1;
  return hit / Math.max(1, end - start + 1);
}

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;

function renderFindings(findings: Finding[]): string {
  const sorted = [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
  const lines = sorted.slice(0, MAX_LISTED).map((f) => `  ${f.file}:${f.line} [${f.severity}/${f.category}] ${f.message}`);
  if (sorted.length > MAX_LISTED) lines.push(`  … ${sorted.length - MAX_LISTED} more`);
  return lines.join('\n');
}

function renderDuplicates(blocks: DuplicateBlock[]): string {
  return blocks.slice(0, 20).map((b) => `  ${b.lines} lines at ${b.locations.map((l) => `${l.file}:${l.line}-${l.endLine}`).join(', ')}\n    ${b.preview}`).join('\n');
}

function renderChecks(results: CheckResult[], changedRels: Set<string> | null, root: string): string {
  return results.map((r) => {
    const where = r.cwd === root ? '' : ` in ${toPosix(path.relative(root, r.cwd))}`;
    const state = r.passed ? 'PASS' : r.unavailable ? 'SKIP' : 'FAIL';
    const head = `  ${state} ${r.check.kind}${where}: ${r.check.command} (${r.check.source}, ${Math.round(r.durationMs / 100) / 10}s${r.timedOut ? ', timed out' : ''})`;
    if (r.passed) return head;
    if (r.unavailable) return `${head}\n    its tool is not installed here, so this was not checked (nothing was installed)`;
    const diags = r.diagnostics.map((d) => ({ ...d, rel: d.file ? toPosix(path.relative(root, path.resolve(r.cwd, d.file))) : '' }));
    const mine = changedRels ? diags.filter((d) => changedRels.has(d.rel)) : diags;
    const other = diags.length - mine.length;
    const render = (d: (typeof diags)[number]) => `    ${d.rel}${d.line ? `:${d.line}` : ''} ${d.severity}: ${d.message}`;
    const body = mine.slice(0, 25).map(render);
    if (other > 0) {
      body.push(`    (+${other} diagnostic(s) in files this change did not touch${mine.length ? '' : ' — likely pre-existing; first ones:'})`);
      if (mine.length === 0) body.push(...diags.slice(0, 5).map(render));
    }
    if (diags.length === 0 && r.tail) body.push(...r.tail.split('\n').map((l) => `    | ${l}`));
    return [head, ...body].join('\n');
  }).join('\n');
}

/** The nearest folder at or above the file, inside root, that holds a project marker (package.json, pyproject.toml, go.mod, *.csproj…); root when none does. */
async function projectRootOf(root: string, rel: string): Promise<string> {
  for (let dir = path.dirname(path.join(root, rel)); dir.length > root.length && dir.startsWith(root); dir = path.dirname(dir)) {
    const names = await fsp.readdir(dir).catch((): string[] => []);
    if (names.some(isProjectMarker)) return dir;
  }
  return root;
}

/** Run the requested checks in each project the changed files belong to (the scope's project when nothing changed). */
async function runChecks(
  root: string,
  scopeRel: string,
  changedRels: string[],
  kinds: CheckKind[],
  testCommand: string | undefined,
  signal?: AbortSignal,
): Promise<{ results: CheckResult[]; missing: CheckKind[] }> {
  const projects = [...new Set(await Promise.all(changedRels.map((rel) => projectRootOf(root, rel))))].sort();
  // Nothing changed: check the project that holds the scope.
  if (projects.length === 0) projects.push(await projectRootOf(root, path.posix.join(scopeRel, '_')));
  const results: CheckResult[] = [];
  const found = new Set<CheckKind>();
  for (const cwd of projects) {
    const tooling = await detectTooling(cwd);
    const checks = tooling.checks.filter((c) => kinds.includes(c.kind) && !(c.kind === 'test' && testCommand));
    for (const check of checks) {
      if (signal?.aborted) break;
      found.add(check.kind);
      results.push(await runCheck(check, { cwd, root: cwd, signal }));
    }
  }
  // The focused test command names its own target, so it runs once, from the workspace root.
  if (testCommand && kinds.includes('test') && !signal?.aborted) {
    found.add('test');
    results.push(await runCheck({ kind: 'test', command: testCommand, source: 'test_command' }, { cwd: root, root, signal }));
  }
  return { results, missing: kinds.filter((k) => !found.has(k)) };
}

function wordRegex(symbol: string): RegExp {
  return new RegExp(`(?<![\\w$])${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w$])`);
}

function finish(display: string, data: Record<string, unknown>, failedChecks: CheckResult[] = []) {
  const { text, truncated } = clamp(display, MAX_DISPLAY);
  if (failedChecks.length > 0) {
    return {
      ok: false,
      kind: 'text' as const,
      display: text,
      truncated,
      error: `Review checks failed: ${failedChecks.map((r) => r.check.kind).join(', ')}`,
      hint: 'Fix the failures listed under [checks], then run code_review again.',
      code: TOOL_ERROR_CODE.EEXIT,
      data,
    };
  }
  return ok({ kind: 'text', display: text, truncated, data });
}

export default defineTool({
  name: 'code_review',
  // The request names review_changes as a call of its own; it is this tool's default operation, so the name alone does the right thing.
  aliases: ['review_changes'],
  profiles: ['core', 'planning'],
  category: 'search',
  activity: 'Reviewing code',
  label: 'Code Review',
  brief: 'Check a code change before you finish: problems on the changed lines, unused or duplicated code, plus the project\'s own lint, typecheck and tests.',
  description:
    'Review code with static analysis and the project\'s own tooling, instead of judging a diff by eye. Operations:\n' +
    '- review_changes (default): the working tree against HEAD (or base), narrowed to path when given; outside a git repository it reviews every file under path whole. Reports problems on the changed lines (error handling, unawaited async calls, unused imports, dead code, security smells, complexity), new unused exports, import cycles and duplicated blocks touching the change. ' +
    'checks:true also runs the project\'s existing lint and typecheck; tests:true its tests (or test_command). Run this before finishing a code change.\n' +
    '- review_file (path), review_symbol (symbol): the same analysis for one file or one function/class.\n' +
    '- find_references (symbol, optional path): every line that names the symbol.\n' +
    '- find_duplicates, find_unused, find_import_cycles, analyze_complexity (optional path to narrow).\n' +
    'Checks run in the project folder that holds the changed files, with the commands it already has (package.json scripts, tsc, eslint/oxlint, knip/madge, ruff/pytest, cargo, go, dotnet); nothing is installed. ' +
    'Findings cover JS/TS, Python, C#, Go, Java, Rust, Ruby, PHP, C++, Bash and PowerShell; unused exports and import cycles are JS/TS only. ' +
    'Also answers questions like: is there dead code, duplicated code, an import cycle, a function that is too complex, and where is this used.',
  parameters: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: [...OPERATIONS], description: 'What to review (default review_changes)' },
      path: { type: 'string', pathArg: true, description: 'File or directory to review or narrow to (workspace-relative)' },
      symbol: { type: 'string', description: 'Symbol name for review_symbol / find_references' },
      base: { type: 'string', description: 'review_changes: compare against this ref instead of HEAD (e.g. main)' },
      checks: { type: 'boolean', description: 'review_changes / review_file: also run the project\'s lint and typecheck (the build, for compiled languages)' },
      tests: { type: 'boolean', description: 'review_changes / review_file: also run the project\'s tests' },
      test_command: { type: 'string', description: 'review_changes / review_file: the focused test command to run instead of the whole suite' },
    },
    required: [],
  },
  volatile: true,
  // Static review only reads; checks and tests run the project's own scripts, which is running its code.
  isRisky(args) {
    return checkKinds(args).length > 0;
  },
  preview(args) {
    const op = String(args?.operation ?? 'review_changes');
    const target = args?.symbol ?? args?.path ?? args?.base ?? '';
    const kinds = checkKinds(args);
    const extra = [kinds.includes('lint') && 'lint/typecheck', kinds.includes('test') && 'tests'].filter(Boolean).join(', ');
    return `${op}${target ? ` ${target}` : ''}${extra ? ` (+${extra})` : ''}`;
  },
  async execute(args, ctx) {
    const operation = String(args.operation ?? 'review_changes').trim().toLowerCase() as Operation;
    if (!OPERATIONS.includes(operation)) {
      return fail(`Unknown operation: ${args.operation}`, { code: TOOL_ERROR_CODE.EINVAL, hint: `One of: ${OPERATIONS.join(', ')}` });
    }
    const root = path.resolve(ctx.root ?? ctx.cwd);
    const relOf = (abs: string) => toPosix(path.relative(root, abs));
    const scopeAbs = typeof args.path === 'string' && args.path ? path.resolve(root, args.path) : null;
    const scopeStat = scopeAbs ? await fsp.stat(scopeAbs).catch((): null => null) : null;
    if (scopeAbs && !scopeStat) return fail(`Path not found: ${args.path}`, { code: TOOL_ERROR_CODE.ENOENT });
    const scopeRel = scopeAbs ? relOf(scopeAbs) : '';
    const inScope = (rel: string) => !scopeRel || rel === scopeRel || rel.startsWith(`${scopeRel}/`);
    const symbol = String(args.symbol ?? '').trim();

    try {
      switch (operation) {
        case 'review_changes':
          return await reviewChanges();
        case 'review_file':
          return await reviewFile();
        case 'review_symbol':
          return await reviewSymbol();
        case 'find_references':
          return await findReferences();
        case 'find_duplicates': {
          const project = await loadProject(root, { signal: ctx.signal });
          const blocks = findDuplicateBlocks([...project.files.values()].map((f) => ({ file: f.rel, text: f.text })), {
            touches: (file) => inScope(file),
          });
          const display = blocks.length ? `duplicated blocks (${blocks.length}):\n${renderDuplicates(blocks)}` : 'no duplicated blocks of 6+ lines';
          return finish(display + partialNote(project), { operation, duplicates: blocks });
        }
        case 'find_unused':
          return await unused();
        case 'find_import_cycles':
          return await cycles();
        case 'analyze_complexity': {
          const project = await loadProject(root, { signal: ctx.signal });
          const fns = [...project.files.values()].filter((f) => inScope(f.rel)).flatMap((f) => f.analysis.functions).sort((a, b) => b.complexity - a.complexity);
          const over = fns.filter((f) => f.complexity > COMPLEXITY_THRESHOLD);
          const lines = fns.slice(0, 30).map(renderMetric);
          const display = `${over.length} of ${fns.length} function(s) above complexity ${COMPLEXITY_THRESHOLD}\n${lines.join('\n')}`;
          return finish(display + partialNote(project), { operation, threshold: COMPLEXITY_THRESHOLD, functions: fns.slice(0, 200), over: over.length });
        }
      }
    } catch (err) {
      return fromError(err);
    }

    async function reviewChanges() {
      const base = args.base ? String(args.base) : undefined;
      const scopeName = scopeRel || 'the workspace';
      let changes: ChangedFile[];
      let allFilesNote: string | null = null;
      try {
        changes = (await collectChanges(root, base, ctx.signal)).filter((c) => inScope(c.rel));
      } catch (err) {
        // No repository means no diff, not nothing to review: review the files in scope whole. A base ref still needs git.
        if ((err as { code?: string })?.code !== TOOL_ERROR_CODE.ENOTREPO || base) throw err;
        const all = await collectAllFiles(root, scopeAbs ?? root, ctx.signal);
        changes = all.files;
        allFilesNote = `not a git repository: reviewed all ${changes.length}${all.capped ? '+' : ''} file(s) under ${scopeName} whole (no diff to narrow to)` +
          (all.capped ? `; stopped at ${MAX_UNTRACKED_REVIEW}, pass path to narrow it` : '') +
          '. Run "git init" and commit to review only what changes.';
      }
      const byRel = new Map(changes.map((c) => [c.rel, c]));
      const kinds = checkKinds(args);
      if (changes.length === 0 && kinds.length === 0) {
        const display = allFilesNote ? `no reviewable files under ${scopeName}` : `no changes to review under ${scopeName} (working tree matches ${base ?? 'HEAD'})`;
        return ok({ kind: 'text', display, data: { operation, files: [] } });
      }

      const reviewable = changes.filter((c) => c.status !== 'deleted' && isReviewable(c.rel));
      const project = reviewable.length ? await loadProject(root, { signal: ctx.signal }) : null;

      const findings: Finding[] = [];
      for (const change of reviewable) {
        const file = project?.files.get(change.rel) ?? (await readAnalyzed(change.rel));
        if (!file) continue;
        for (const f of file.analysis.findings) {
          if (f.category === 'complexity') continue;
          if (touchesLines(change, f.line, f.line)) findings.push(f);
        }
        for (const fn of file.analysis.functions) {
          // A one-line touch to an old complex function is not this change's complexity; a new or largely rewritten one is.
          if (fn.complexity > COMPLEXITY_THRESHOLD && changedShare(change, fn.line, fn.endLine) >= 0.3) {
            findings.push({ file: fn.file, line: fn.line, category: 'complexity', severity: 'info', message: `${fn.name} (changed) has cyclomatic complexity ${fn.complexity}; consider splitting it` });
          }
        }
      }

      const sections: string[] = allFilesNote ? [allFilesNote] : [];
      const changedList = changes.map((c) => `  ${c.status.padEnd(9)} ${c.rel}${c.lines ? ` (${c.lines.size} changed line${c.lines.size === 1 ? '' : 's'})` : ''}`);
      sections.push(`changed files (${changes.length}):\n${changedList.join('\n') || '  (none)'}`);

      let cyclesHit: string[][] = [];
      let duplicates: DuplicateBlock[] = [];
      if (project) {
        const report = findUnused(project, (rel) => byRel.has(rel));
        for (const exp of report.exports) {
          if (touchesLines(byRel.get(exp.file), exp.line, exp.line)) {
            findings.push({ file: exp.file, line: exp.line, category: 'unused', severity: 'info', message: `export ${exp.name} is not imported anywhere in the workspace` });
          }
        }
        for (const rel of report.files) {
          const status = byRel.get(rel)?.status;
          if (status === 'added' || status === 'untracked') {
            findings.push({ file: rel, line: 1, category: 'unused', severity: 'info', message: 'new file is not imported by any other file' });
          }
        }
        cyclesHit = findCycles(project.edges).filter((c) => c.some((rel) => byRel.has(rel)));
        duplicates = findDuplicateBlocks([...project.files.values()].map((f) => ({ file: f.rel, text: f.text })), {
          touches: (file, start, end) => touchesLines(byRel.get(file), start, end),
        });
      }

      sections.push(findings.length ? `findings on changed code (${findings.length}):\n${renderFindings(findings)}` : 'findings on changed code: none');
      if (cyclesHit.length) sections.push(`import cycles through changed files:\n${cyclesHit.map((c) => `  ${c.join(' -> ')}`).join('\n')}`);
      if (duplicates.length) sections.push(`duplicated blocks touching the change:\n${renderDuplicates(duplicates)}`);
      const skipped = changes.filter((c) => c.status !== 'deleted' && !isReviewable(c.rel)).length;
      if (skipped) sections.push(`${skipped} changed file(s) in a language with no parser here got no structural analysis; use run_script or read them for a closer look.`);

      const checked = await projectChecks(changes.filter((c) => c.status !== 'deleted').map((c) => c.rel), kinds);
      if (checked.section) sections.push(checked.section);
      sections.push(`[judge]\n${JUDGE_CHECKLIST}`);
      if (project?.partial) sections.push(partialNote(project).trim());

      return finish(sections.join('\n\n'), {
        operation,
        mode: allFilesNote ? 'all-files' : 'diff',
        files: changes.map((c) => ({ path: c.rel, status: c.status, changedLines: c.lines?.size ?? null })),
        findings,
        cycles: cyclesHit,
        duplicates,
        ...checked.data,
      }, checked.failed);
    }

    /** Run the requested checks in the projects holding `rels`, as the `[checks]` section, its data, and the real failures. */
    async function projectChecks(rels: string[], kinds: CheckKind[]) {
      if (kinds.length === 0) return { section: '', data: {}, failed: [] as CheckResult[] };
      const ran = await runChecks(root, scopeRel, rels, kinds, args.test_command ? String(args.test_command) : undefined, ctx.signal);
      const lines = [renderChecks(ran.results, new Set(rels), root)].filter(Boolean);
      if (ran.missing.length) lines.push(`  not available in this project: ${ran.missing.join(', ')} (nothing was installed)`);
      const verification = combineVerification(ran.results);
      return {
        section: `[checks]\n${lines.join('\n')}`,
        data: {
          checks: ran.results.map((r) => ({ kind: r.check.kind, project: toPosix(path.relative(root, r.cwd)) || '.', command: r.check.command, source: r.check.source, passed: r.passed, unavailable: r.unavailable, exitCode: r.exitCode, durationMs: r.durationMs, diagnostics: r.diagnostics })),
          ...(verification ? { verification } : {}),
        },
        failed: ran.results.filter((r) => !r.passed && !r.unavailable),
      };
    }

    async function readAnalyzed(rel: string) {
      const text = await fsp.readFile(path.join(root, rel), 'utf8').catch((): null => null);
      const analysis = text === null ? null : await analyzeFile(rel, text);
      return analysis ? { rel, text: text!, analysis } : null;
    }

    async function reviewFile() {
      if (!scopeAbs || !scopeStat?.isFile()) return fail('review_file needs path naming a file', { code: TOOL_ERROR_CODE.EINVAL });
      if (!isReviewable(scopeRel)) {
        return fail(`review_file has no parser for ${scopeRel}`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Read the file, or write a run_script that checks what you need.',
        });
      }
      const project = await loadProject(root, { signal: ctx.signal });
      const file = project.files.get(scopeRel) ?? (await readAnalyzed(scopeRel));
      if (!file) return fail(`Could not read ${scopeRel}`, { code: TOOL_ERROR_CODE.ENOENT });
      const findings = [...file.analysis.findings];
      for (const exp of findUnused(project, (rel) => rel === scopeRel).exports) {
        findings.push({ file: exp.file, line: exp.line, category: 'unused', severity: 'info', message: `export ${exp.name} is not imported anywhere in the workspace` });
      }
      const cyc = findCycles(project.edges).filter((c) => c.includes(scopeRel));
      const dup = findDuplicateBlocks([...project.files.values()].map((f) => ({ file: f.rel, text: f.text })), { touches: (f) => f === scopeRel });
      const top = [...file.analysis.functions].sort((a, b) => b.complexity - a.complexity).slice(0, 5);
      const sections = [
        `${scopeRel}: ${file.analysis.functions.length} function(s), ${file.analysis.imports.length} import(s), ${file.analysis.exports.length} export(s)`,
        findings.length ? `findings (${findings.length}):\n${renderFindings(findings)}` : 'findings: none',
        top.length ? `most complex:\n${top.map(renderMetric).join('\n')}` : '',
        cyc.length ? `import cycles:\n${cyc.map((c) => `  ${c.join(' -> ')}`).join('\n')}` : '',
        dup.length ? `duplicated blocks:\n${renderDuplicates(dup)}` : '',
      ].filter(Boolean);
      const checked = await projectChecks([scopeRel], checkKinds(args));
      if (checked.section) sections.push(checked.section);
      sections.push(`[judge]\n${JUDGE_CHECKLIST}`);
      return finish(sections.join('\n\n'), { operation, file: scopeRel, findings, cycles: cyc, duplicates: dup, functions: file.analysis.functions, ...checked.data }, checked.failed);
    }

    async function reviewSymbol() {
      if (!symbol) return fail('review_symbol needs symbol', { code: TOOL_ERROR_CODE.EINVAL });
      const project = await loadProject(root, { signal: ctx.signal });
      const re = wordRegex(symbol);
      const defs: FunctionMetric[] = [];
      const exportedFrom: string[] = [];
      const findings: Finding[] = [];
      const references: Array<{ file: string; line: number; text: string }> = [];
      for (const file of project.files.values()) {
        if (!inScope(file.rel)) continue;
        const fns = file.analysis.functions.filter((f) => f.name === symbol);
        defs.push(...fns);
        if (file.analysis.exports.some((e) => e.name === symbol)) exportedFrom.push(file.rel);
        for (const fn of fns) findings.push(...file.analysis.findings.filter((f) => f.line >= fn.line && f.line <= fn.endLine));
        file.text.split('\n').forEach((line, i) => {
          if (re.test(line)) references.push({ file: file.rel, line: i + 1, text: line.trim().slice(0, 160) });
        });
      }
      if (defs.length === 0 && exportedFrom.length === 0 && references.length === 0) {
        return ok({ kind: 'text', display: `${symbol}: not found in JS/TS files${scopeRel ? ` under ${scopeRel}` : ''}`, data: { operation, symbol, references: [] } });
      }
      const sections = [
        defs.length ? `definitions:\n${defs.map(renderMetric).join('\n')}` : `definitions: none found as a function${exportedFrom.length ? '' : ' or export'}`,
        exportedFrom.length ? `exported from: ${exportedFrom.join(', ')}` : '',
        `references (${references.length}):\n${references.slice(0, MAX_LISTED).map((r) => `  ${r.file}:${r.line}: ${r.text}`).join('\n')}${references.length > MAX_LISTED ? `\n  … ${references.length - MAX_LISTED} more` : ''}`,
        findings.length ? `findings inside the definition:\n${renderFindings(findings)}` : '',
        `[judge]\n${JUDGE_CHECKLIST}`,
      ].filter(Boolean);
      return finish(sections.join('\n\n'), { operation, symbol, definitions: defs, exportedFrom, references, findings });
    }

    async function findReferences() {
      if (!symbol) return fail('find_references needs symbol', { code: TOOL_ERROR_CODE.EINVAL });
      const re = wordRegex(symbol);
      const scan = await scanContent({ root: scopeAbs ?? root, base: root, test: (line) => re.test(line), maxResults: 300, signal: ctx.signal });
      const index = (ctx as any)?.state?.index as IndexHandle | null;
      const indexed = index?.db ? lookupSymbol(index, symbol, (abs) => ctx.ws.rel(abs)) : null;
      const defs = indexed ? [...indexed.definitions.values()] : [];
      const lines = scan.matches.map((m) => `  ${m.file}:${m.line}: ${m.text.trim()}`);
      const display = [
        defs.length ? `defined in (index): ${defs.map((d) => `${d.file} (${d.kind})`).join(', ')}` : '',
        `references (${scan.matches.length}${scan.truncated ? '+' : ''}):\n${lines.join('\n') || '  none'}`,
      ].filter(Boolean).join('\n\n');
      return finish(display, {
        operation,
        symbol,
        definitions: defs,
        importers: indexed ? [...indexed.importers.entries()].map(([file, imports]) => ({ file, imports })) : [],
        references: scan.matches,
        truncated: scan.truncated,
      });
    }

    async function unused() {
      const tooling = await detectTooling(root);
      if (tooling.analyzers.knip) {
        const items = await runKnip(root, ctx.signal);
        if (items) {
          const mine = items.filter((i) => inScope(toPosix(i.file)));
          const display = `knip (project-installed) reported ${mine.length} unused item(s):\n` +
            mine.slice(0, MAX_LISTED * 2).map((i) => `  ${i.file}${i.line ? `:${i.line}` : ''} [${i.kind}] ${i.name}`).join('\n');
          return finish(display, { operation, tool: 'knip', items: mine });
        }
      }
      const project = await loadProject(root, { signal: ctx.signal });
      const report = findUnused(project, inScope);
      const sections = [
        `unused imports (${report.imports.length}):\n${report.imports.slice(0, MAX_LISTED).map((i) => `  ${i.file}:${i.line} ${i.name} from "${i.source}"`).join('\n') || '  none'}`,
        `exports nothing imports (${report.exports.length}):\n${report.exports.slice(0, MAX_LISTED).map((e) => `  ${e.file}:${e.line} ${e.name}`).join('\n') || '  none'}`,
        `files nothing imports (${report.files.length}):\n${report.files.slice(0, MAX_LISTED).map((f) => `  ${f}`).join('\n') || '  none'}`,
        'Built-in analysis: relative imports only; dynamic access, package entry points and non-JS consumers are invisible, so trace references before deleting anything.',
      ];
      return finish(sections.join('\n\n') + partialNote(project), { operation, tool: 'built-in', ...report });
    }

    async function cycles() {
      const tooling = await detectTooling(root);
      if (tooling.analyzers.madge) {
        const found = await runMadge(scopeAbs && scopeStat?.isDirectory() ? scopeAbs : root, ctx.signal);
        if (found) {
          const display = found.length ? `madge (project-installed) found ${found.length} cycle(s):\n${found.map((c) => `  ${c.join(' -> ')}`).join('\n')}` : 'madge: no import cycles';
          return finish(display, { operation, tool: 'madge', cycles: found });
        }
      }
      const project = await loadProject(root, { signal: ctx.signal });
      const found = findCycles(project.edges).filter((c) => c.some(inScope));
      const display = found.length ? `import cycles (${found.length}):\n${found.map((c) => `  ${c.join(' -> ')}`).join('\n')}` : 'no import cycles between workspace files';
      return finish(display + partialNote(project), { operation, tool: 'built-in', cycles: found });
    }
  },
});

function renderMetric(f: FunctionMetric): string {
  const flag = f.complexity > COMPLEXITY_THRESHOLD ? ' !' : '';
  return `  ${f.file}:${f.line} ${f.name} complexity ${f.complexity}, ${f.lines} lines${flag}`;
}

function partialNote(project: Project): string {
  return project.partial ? `\n\n(stopped after ${project.files.size} files; narrow with path for a complete answer)` : '';
}
