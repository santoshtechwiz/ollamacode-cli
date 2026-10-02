/** The project's own review tooling: detect what is already installed and run it the way exec_shell does. Never installs anything. */

import path from 'node:path';

import { exists, readJson, detectPackageManager } from '../../env/tooling/probe';
import { detectStacks } from '../../env/tooling/detector';
import { executeShell } from '../process/execution/execute';
import { classifyCommand } from '../process/analysis/classify-command';
import { parseShellDiagnostics } from '../process/analysis/diagnostics';
import { createVerificationMetadata } from '../process/analysis/verification';
import type { Diagnostic, VerificationMetadata } from '../process/types';

export type CheckKind = 'lint' | 'typecheck' | 'test';

export interface ReviewCheck {
  kind: CheckKind;
  command: string;
  /** Where the command came from, e.g. "package.json script" or "node_modules/.bin/tsc". */
  source: string;
}

export interface ReviewTooling {
  checks: ReviewCheck[];
  /** Optional analysers found in node_modules/.bin. */
  analyzers: { knip: boolean; madge: boolean };
}

const NO_TEST_SCRIPT = /no test specified/i;

/** Stacks whose build compiles the code, so it fails on type errors. Python's build packages and Terraform's formats, so neither is listed. */
const COMPILED_STACKS = new Set(['dotnet', 'go', 'rust']);

async function hasBin(root: string, name: string): Promise<boolean> {
  const bin = path.join(root, 'node_modules', '.bin', name);
  return (await exists(bin)) || (process.platform === 'win32' && (await exists(`${bin}.cmd`)));
}

async function hasAny(root: string, names: string[]): Promise<boolean> {
  for (const name of names) if (await exists(path.join(root, name))) return true;
  return false;
}

const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];

/** Lint, typecheck and test commands the project already has: its own scripts first, then installed binaries. */
export async function detectTooling(root: string): Promise<ReviewTooling> {
  const checks: ReviewCheck[] = [];
  const pkg = await readJson(path.join(root, 'package.json'));
  const analyzers = { knip: await hasBin(root, 'knip'), madge: await hasBin(root, 'madge') };

  if (pkg) {
    const scripts: Record<string, string> = pkg.scripts ?? {};
    const pm = await detectPackageManager(root);
    const run = (name: string) => (pm === 'npm' ? `npm run ${name}` : `${pm} ${name}`);
    const script = (names: string[]) => names.find((n) => typeof scripts[n] === 'string' && scripts[n].trim());

    const lint = script(['lint']);
    if (lint) checks.push({ kind: 'lint', command: run(lint), source: 'package.json script' });
    else if (await hasBin(root, 'oxlint')) checks.push({ kind: 'lint', command: 'npx --no-install oxlint', source: 'node_modules/.bin/oxlint' });
    else if ((await hasBin(root, 'eslint')) && (await hasAny(root, ESLINT_CONFIGS))) {
      checks.push({ kind: 'lint', command: 'npx --no-install eslint .', source: 'node_modules/.bin/eslint' });
    }

    const typecheck = script(['typecheck', 'type-check', 'tsc', 'check-types']);
    if (typecheck) checks.push({ kind: 'typecheck', command: run(typecheck), source: 'package.json script' });
    else if ((await exists(path.join(root, 'tsconfig.json'))) && (await hasBin(root, 'tsc'))) {
      checks.push({ kind: 'typecheck', command: 'npx --no-install tsc --noEmit', source: 'node_modules/.bin/tsc' });
    }

    if (scripts.test && !NO_TEST_SCRIPT.test(scripts.test)) {
      checks.push({ kind: 'test', command: pm === 'npm' ? 'npm test' : `${pm} test`, source: 'package.json script' });
    }
    return { checks, analyzers };
  }

  // Other stacks: the lint/test commands the language table already knows for this root.
  const stack = (await detectStacks(root)).find((s) => path.resolve(s.root) === path.resolve(root));
  if (stack?.lint) checks.push({ kind: 'lint', command: stack.lint.join(' '), source: `${stack.label} default` });
  // Where the compiler is the type checker, the build is the typecheck.
  if (stack?.build && COMPILED_STACKS.has(stack.id)) checks.push({ kind: 'typecheck', command: stack.build.join(' '), source: `${stack.label} build` });
  if (stack?.test) checks.push({ kind: 'test', command: stack.test.join(' '), source: `${stack.label} default` });
  return { checks, analyzers };
}

export interface CheckResult {
  check: ReviewCheck;
  /** Where it ran: the project root that holds the changed files. */
  cwd: string;
  passed: boolean;
  /** The command's tool is not installed, so nothing was checked; this does not fail the review. */
  unavailable: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  diagnostics: Diagnostic[];
  verification: VerificationMetadata;
  /** The tail of the output, for a failure with no parsed diagnostics. */
  tail: string;
}

const DEFAULT_CHECK_TIMEOUT_MS = 300_000;

// The shells', Python's and npx's own words for "that program is not installed".
const MISSING_TOOL = /No module named \w+|^\S*sh: (?:\d+: )?\S+: not found$|is not recognized as (?:an internal or external command|the name of a cmdlet)|command not found|could not determine executable to run|executable file not found/im;

/** Run one check through the same execution, classification and diagnostics path as exec_shell. */
export async function runCheck(
  check: ReviewCheck,
  { cwd, root, signal, timeoutMs = DEFAULT_CHECK_TIMEOUT_MS }: { cwd: string; root?: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<CheckResult> {
  const execution = await executeShell({ command: check.command, cwd, timeoutMs, signal });
  const classification = classifyCommand(check.command);
  const diagnostics = await parseShellDiagnostics(execution.stdout, execution.stderr, { command: check.command, root, cwd });
  const verification = createVerificationMetadata({ execution, classification, diagnostics });
  // An unrecognised linter (oxlint) still is the lint check it was detected as.
  if (verification.intent === 'none') verification.intent = check.kind;
  const passed = execution.exitCode === 0 && !execution.timedOut && !execution.spawnError;
  verification.passed = passed;
  const combined = `${execution.stdout}\n${execution.stderr}`.trim();
  const unavailable = !passed && (Boolean(execution.spawnError) || MISSING_TOOL.test(combined));
  return {
    check,
    cwd,
    passed,
    unavailable,
    exitCode: execution.exitCode,
    timedOut: execution.timedOut,
    durationMs: execution.durationMs,
    diagnostics,
    verification,
    tail: combined.split('\n').slice(-15).join('\n'),
  };
}

/** One verification record for several checks, in the shape the turn's verification store reads. */
export function combineVerification(all: CheckResult[]): VerificationMetadata | undefined {
  const results = all.filter((r) => !r.unavailable);
  if (results.length === 0) return undefined;
  const failed = results.find((r) => !r.passed);
  const pick = failed ?? results[results.length - 1];
  const diagnostics = results.flatMap((r) => r.diagnostics);
  return {
    ...pick.verification,
    intent: results.some((r) => r.check.kind === 'test') ? 'test' : 'check',
    passed: !failed,
    exitCode: failed ? failed.exitCode : 0,
    diagnostics,
    primaryDiagnostic: failed?.verification.primaryDiagnostic,
  };
}

/** knip's JSON report, flattened to file/name pairs; null when knip did not produce JSON. */
export async function runKnip(cwd: string, signal?: AbortSignal): Promise<Array<{ file: string; kind: string; name: string; line?: number }> | null> {
  const execution = await executeShell({ command: 'npx --no-install knip --reporter json --no-exit-code', cwd, timeoutMs: DEFAULT_CHECK_TIMEOUT_MS, signal });
  let parsed: any;
  try {
    parsed = JSON.parse(execution.stdout.trim());
  } catch {
    return null;
  }
  const out: Array<{ file: string; kind: string; name: string; line?: number }> = [];
  for (const file of parsed?.files ?? []) out.push({ file: String(file), kind: 'file', name: '' });
  for (const issue of parsed?.issues ?? []) {
    for (const [kind, value] of Object.entries(issue)) {
      if (kind === 'file' || !Array.isArray(value)) continue;
      for (const item of value as any[]) out.push({ file: String(issue.file), kind, name: String(item?.name ?? item), line: item?.line });
    }
  }
  return out;
}

/** madge's circular-dependency list; null when madge did not produce JSON. */
export async function runMadge(cwd: string, signal?: AbortSignal): Promise<string[][] | null> {
  const execution = await executeShell({
    command: 'npx --no-install madge --circular --json --extensions ts,tsx,js,jsx,mjs,cjs .',
    cwd,
    timeoutMs: DEFAULT_CHECK_TIMEOUT_MS,
    signal,
  });
  try {
    const parsed = JSON.parse(execution.stdout.trim());
    return Array.isArray(parsed) ? parsed.map((c: unknown) => (Array.isArray(c) ? c.map(String) : [])) : null;
  } catch {
    return null;
  }
}
