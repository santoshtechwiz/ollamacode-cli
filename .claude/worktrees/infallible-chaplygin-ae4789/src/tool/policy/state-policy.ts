import { normalizeRelPath } from '../../core/paths';
import {
  classifyTool,
  normalizeToolName,
  GIT_MUTATING_PATTERN,
  PACKAGE_COMMAND_PATTERN,
} from './mutation-policy';
import { isProjectMarker, MANIFEST_FILES_LOWER } from '../../env/languages';
import type { CommandClassify, ToolMetaMap } from './mutation-policy';
import { targetPathArg } from './target';

/** The shape of an approved plan the plan-gate is allowed to read. */
export interface PlanLike {
  summary: string;
  steps: string[];
  files: { create: string[]; edit: string[]; del: string[] };
  runs?: string[];
  constraints?: string[];
  raw: string;
}

export interface PlanGateOptions {
  /** The live tool metadata, so classification matches the gate. */
  meta?: ToolMetaMap;
  /** The command classifiers, wired by the caller like `classifyTool`. */
  cmd?: CommandClassify;
  /** The git operations that write, from the git tool's own list. */
  gitWriteOps?: ReadonlySet<string>;
}

function normalizePlanText(plan: PlanLike): string {
  return [
    plan.raw ?? '',
    ...(plan.steps ?? []),
    plan.summary ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

function plannedPaths(plan: PlanLike): Set<string> {
  return new Set(
    [
      ...(plan.files?.create ?? []),
      ...(plan.files?.edit ?? []),
      ...(plan.files?.del ?? []),
    ]
      .map((path) => normalizeRelPath(path))
      .filter(Boolean),
  );
}

function isPlannedPath(
  target: string,
  planned: Set<string>,
): boolean {
  return planned.has(target);
}

function isPlannedParentDirectory(
  target: string,
  planned: Set<string>,
): boolean {
  if (!target || target === '.') {
    return false;
  }

  const basename = target.split('/').pop() ?? '';

  // A directory target must actually look like a directory.
  if (basename.includes('.')) {
    return false;
  }

  for (const plannedPath of planned) {
    if (plannedPath.startsWith(`${target}/`)) {
      return true;
    }
  }

  return false;
}

function commandMentionsPlannedPath(
  command: string,
  planned: Set<string>,
): boolean {
  if (planned.size === 0) {
    return false;
  }

  const normalizedCommand = command
    .replace(/["']/g, '')
    .toLowerCase();

  return [...planned].some((plannedPath) => {
    const normalizedPath = plannedPath.toLowerCase();

    return (
      normalizedCommand.includes(normalizedPath) ||
      normalizedCommand.includes(normalizedPath.replace(/\\/g, '/'))
    );
  });
}

function commandMentionsPlannedRun(
  command: string,
  plan: PlanLike,
): boolean {
  const runs = (plan.runs ?? [])
    .map((run) => run.trim().toLowerCase())
    .filter(Boolean);

  if (runs.length === 0) {
    return false;
  }

  const normalizedCommand = command.trim().toLowerCase();

  return runs.some(
    (run) =>
      normalizedCommand.includes(run) ||
      run.includes(normalizedCommand),
  );
}

function commandTargetsPackagePhase(
  command: string,
  plan: PlanLike,
): boolean {
  if (!PACKAGE_COMMAND_PATTERN.test(command)) {
    return false;
  }

  const planned = plannedPaths(plan);

  for (const file of planned) {
    const basename = file.split('/').pop() ?? '';

    if (
      MANIFEST_FILES_LOWER.has(basename.toLowerCase()) ||
      isProjectMarker(basename)
    ) {
      return true;
    }
  }

  return false;
}

function isPlannedGitCommand(
  command: string,
  plan: PlanLike,
): boolean {
  const normalized = command.trim().toLowerCase();

  if (!GIT_MUTATING_PATTERN.test(normalized)) {
    return false;
  }

  const planText = normalizePlanText(plan);

  if (!planText.includes('git')) {
    return false;
  }

  const operation = normalized
    .replace(/^git\s+/, '')
    .split(/\s+/)[0];

  return planText.includes(operation);
}

function isPlannedRunCommand(
  command: string,
  plan: PlanLike,
): boolean {
  const planned = plannedPaths(plan);

  if (commandMentionsPlannedPath(command, planned)) {
    return true;
  }

  if (commandMentionsPlannedRun(command, plan)) {
    return true;
  }

  if (commandTargetsPackagePhase(command, plan)) {
    return true;
  }

  if (isPlannedGitCommand(command, plan)) {
    return true;
  }

  const planText = normalizePlanText(plan);

  if (
    /\bmkdir\b/i.test(command) &&
    /\bmkdir\b/i.test(planText) &&
    planned.size > 0
  ) {
    return true;
  }

  return false;
}

function isPlannedGitTool(
  args: Record<string, unknown>,
  plan: PlanLike,
  gitWriteOps?: ReadonlySet<string>,
): boolean {
  const operation = String(args?.operation ?? '')
    .trim()
    .toLowerCase();

  if (!operation) {
    return false;
  }

  if (!gitWriteOps?.has(operation)) {
    return true;
  }

  const planText = normalizePlanText(plan);

  if (!planText.includes('git')) {
    return false;
  }

  return planText.includes(operation);
}

/** Determines whether a mutating tool call is authorized by the active plan. */
export function isInPlan(
  plan: PlanLike | null,
  toolName: string,
  args: Record<string, unknown>,
  _readFiles?: Set<string>,
  opts: PlanGateOptions = {},
): boolean {
  // No active plan means plan gating is disabled.
  if (!plan) {
    return true;
  }

  const name = normalizeToolName(toolName);
  const classification = classifyTool(name, args, {
    meta: opts.meta,
    cmd: opts.cmd,
  });

  // Read-only operations don't require plan authorization.
  if (classification === 'read-only') {
    return true;
  }

  // Shell commands require explicit plan evidence.
  if (name === 'exec_shell') {
    return isPlannedRunCommand(
      String(args?.command ?? ''),
      plan,
    );
  }

  // Git has operation-level semantics rather than a single path target.
  if (name === 'git') {
    return isPlannedGitTool(args, plan, opts.gitWriteOps);
  }

  const targetArg = targetPathArg(name, opts.meta ?? {});

  // A mutating tool with no known target cannot be proven to be authorized by the plan.
  if (!targetArg) {
    return false;
  }

  const rawPath = String(args?.[targetArg] ?? '').trim();

  if (!rawPath) {
    return false;
  }

  const target = normalizeRelPath(rawPath);

  if (!target) {
    return false;
  }

  const planned = plannedPaths(plan);

  // A plan with no file targets cannot authorize an arbitrary file mutation.
  if (planned.size === 0) {
    return false;
  }

  // Exact planned target.
  if (isPlannedPath(target, planned)) {
    return true;
  }

  // create_directory is allowed when it creates a parent directory required by another planned file.
  if (name === 'create_directory') {
    return isPlannedParentDirectory(target, planned);
  }

  // Manifest/config files are NOT automatically authorized anymore.

  return false;
}