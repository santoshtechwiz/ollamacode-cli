import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { WRITE_PLAN_BASE } from '../../prompts/planning';
import { isPlanEmpty, parsePlan, stepFileScope, validatePlan } from './plan';
import type { Plan as LegacyPlan } from './plan';
import type {
  Observation,
  Plan,
  Planner,
  PlanningContext,
  PlanningReason,
  PlanningResult,
  PlanStep,
  PlanStepType,
} from './plan-types';

export type { PlanningContext, PlanningResult, Planner } from './plan-types';

export class PlannerError extends Error {
  readonly code: 'EMPTY' | 'INVALID' | 'CANCELLED';

  constructor(code: PlannerError['code'], message: string) {
    super(message);
    this.name = 'PlannerError';
    this.code = code;
  }
}

export interface PlannerDeps {
  readonly cwd?: string;
}

/**
 * Reads the plan the model presented with present_plan into the typed plan Turn executes.
 * The model explored the project first, in a read-only turn, so this never calls it again.
 */
class PresentedPlanReader implements Planner {
  private readonly deps: PlannerDeps;

  constructor(deps: PlannerDeps) {
    this.deps = deps;
  }

  async fromPresented(context: PlanningContext, presented: string, files?: readonly string[] | null, steps?: readonly string[] | null): Promise<PlanningResult> {
    const goal = context.goal.trim();
    if (!goal) {
      return { kind: 'CLARIFICATION', reason: 'No goal was provided — describe what should change.' };
    }
    const text = presented.trim();
    if (text === '') throw new PlannerError('EMPTY', 'The model presented no plan.');

    const read = parsePlan(text);
    // A checklist the model gave is the plan's steps; reading them out of its prose is the fallback.
    const parsed = steps && steps.length > 0 ? { ...read, steps: steps.map((s) => String(s).trim()).filter(Boolean) } : read;

    // The model may judge that no file changes are needed or that the request is too small to plan.
    if (parsed.skip) {
      return { kind: 'NO_PLAN', reason: 'NO_PLAN_NEEDED: the request is too small to plan.' };
    }
    if (parsed.noChangesNeeded) {
      const summary = parsed.summary.trim() || 'Reviewed the code — nothing needs to change.';
      return { kind: 'NO_PLAN', reason: `NOTHING_TO_CHANGE: ${summary}` };
    }
    if (isPlanEmpty(parsed)) {
      throw new PlannerError('EMPTY', 'The presented plan has no usable steps.');
    }

    // Files the model listed are the scope; disk says which exist (edit) and which do not yet (create).
    // A plan given only in words is scoped by the files it names that exist on disk, whatever their
    // extension, plus what the prose reading found — never by an extension list alone.
    const named = files && files.length > 0 ? [...files] : existingFilesNamed(text, this.deps.cwd ?? '');
    const fromProse = [...(parsed.files.create ?? []), ...(parsed.files.edit ?? []), ...(parsed.files.del ?? [])];
    const listed = files && files.length > 0 ? named : named.length > 0 ? [...new Set([...fromProse, ...named])] : null;
    const scoped = listed ? { ...parsed, files: { ...parsed.files, create: listed, edit: [] } } : parsed;
    const grounded = await groundFileClassification(validatePlan(scoped), this.deps.cwd ?? '');
    const plan = { ...toTypedPlan(goal, grounded, listed !== null), text };
    validateTypedPlan(plan);
    return { kind: 'PLAN', plan };
  }
}

export function createPlanner(deps: PlannerDeps): Planner {
  return new PresentedPlanReader(deps);
}

/** Build the context Turn hands to the planner for an explicit reason. */
export function planningContextFor(
  goal: string,
  reason: PlanningReason,
  options: {
    observations?: readonly Observation[];
    feedback?: string;
    stacks?: PlanningContext['stacks'];
  } = {},
): PlanningContext {
  return {
    goal,
    observations: options.observations ?? [],
    reason,
    ...(options.feedback ? { feedback: options.feedback } : {}),
    ...(options.stacks ? { stacks: options.stacks } : {}),
  };
}

/** What plan mode asks of the model: look first with the read-only tools, then present the plan in the format the reader parses. */
export function planModeInstruction(context: PlanningContext, cwd: string): string {
  const parts = [
    'You are in plan mode: nothing may be changed yet. Look at what you need with the read-only tools, then call present_plan with your plan and stop. ' +
      'A request that only asks a question is answered, not planned: reply NOTHING_TO_CHANGE followed by the full answer.',
    WRITE_PLAN_BASE,
  ];
  const hint = verificationHintFor(cwd, context.stacks);
  if (hint) parts.push(hint);
  if (context.feedback?.trim()) parts.push(`Feedback on the previous plan: ${context.feedback.trim().slice(0, 1000)}`);
  return parts.join('\n');
}

function classifyStepType(description: string): PlanStepType {
  const text = description.trim();
  // A step that names its file is file work, whatever words it uses ("Create test/x.test.js" is not a test run).
  if (/;\s*file\s*:/i.test(text)) return 'edit';
  if (/^run\s*:?/i.test(text)) return 'run';
  if (/^(verify|validate|check|test|confirm|ensure)\b/i.test(text)) return 'verify';
  if (/^(read|review|inspect|view|open|list|check|look|find|search|explore)\b/i.test(text)) return 'inspect';
  // The heading clause says what the step is; "Create the project; Run `dotnet new`" is setup, not a verification.
  const heading = text.split(/;\s/)[0];
  if (/\b(run|execute|test|verify|lint|build|typecheck)\b/i.test(heading)) return 'verify';
  return 'edit';
}

function newPlanId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `plan-${Date.now().toString(36)}`;
  }
}

/** Workspace files a plan's text names, found by asking the disk rather than by recognising extensions. */
function existingFilesNamed(text: string, cwd: string): string[] {
  if (!cwd) return [];
  const tokens = String(text ?? '').match(/[\w@.\/\\-]*[\w@-]\.[A-Za-z0-9]{1,8}\b/g) ?? [];
  const found: string[] = [];
  for (const raw of new Set(tokens)) {
    const token = raw.replace(/^\.\//, '');
    if (/^[a-z]+:/i.test(token) || token.includes('..')) continue;
    try {
      if (fs.statSync(path.resolve(cwd, token)).isFile()) found.push(token);
    } catch {
      // Not a file here: a version number, a sentence, or a file the plan will create.
    }
  }
  return found;
}

function toTypedPlan(goal: string, legacy: LegacyPlan, listedFiles = false): Plan {
  const steps: PlanStep[] = (legacy.steps ?? []).map((description, index) => ({
    id: `step-${index + 1}`,
    description: String(description ?? '').replace(/\s+/g, ' ').trim(),
    type: classifyStepType(String(description ?? '')),
    status: 'pending' as const,
  }));
  const files = listedFiles
    ? { create: [...(legacy.files.create ?? [])], edit: [...(legacy.files.edit ?? [])], del: [...(legacy.files.del ?? [])] }
    : undefined;
  return { id: newPlanId(), goal: goal.trim().slice(0, 200), steps, ...(files ? { files } : {}) };
}

function validateTypedPlan(plan: Plan): void {
  if (!plan.goal.trim()) {
    throw new PlannerError('INVALID', 'Planner output is missing a goal.');
  }
  if (plan.steps.length === 0) {
    throw new PlannerError('INVALID', 'Planner output has no steps.');
  }
  const seen = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id.trim()) throw new PlannerError('INVALID', 'Planner step is missing an id.');
    if (seen.has(step.id)) throw new PlannerError('INVALID', `Duplicate planner step id: ${step.id}.`);
    seen.add(step.id);
    if (!step.description.trim()) {
      throw new PlannerError('INVALID', `Planner step ${step.id} has an empty description.`);
    }
    if (step.type !== 'inspect' && step.type !== 'edit' && step.type !== 'run' && step.type !== 'verify') {
      throw new PlannerError('INVALID', `Planner step ${step.id} has an invalid type.`);
    }
    if (step.status !== 'pending' && step.status !== 'completed' && step.status !== 'failed') {
      throw new PlannerError('INVALID', `Planner step ${step.id} has an invalid status.`);
    }
  }
}

/**
 * Convert the typed plan back to the legacy shape Turn, the store, and the
 * execution pin read. New code should prefer the typed plan; this adapter
 * exists so the redesign does not rewrite execution and the CLI.
 */
export function toLegacyPlan(plan: Plan): LegacyPlan {
  const steps = plan.steps.map((s) => s.description);
  const create: string[] = [];
  const edit: string[] = [];
  const del: string[] = [];
  const runs: string[] = [];
  for (const step of plan.steps) {
    if (step.type === 'run' || step.type === 'verify') {
      const command = step.description.replace(/^run\s*:?\s*/i, '').split(/\s[—–-]\s|:\s/)[0]?.trim();
      if (command) runs.push(command.slice(0, 200));
      continue;
    }
    // A listed scope is the plan's own; only a plan given in words has its files read out of the steps.
    if (plan.files) continue;
    const scope = stepFileScope(step.description);
    if (scope.op === 'create') create.push(...scope.files);
    else if (scope.op === 'delete') del.push(...scope.files);
    else if (scope.op === 'edit') edit.push(...scope.files);
  }
  if (plan.files) {
    create.push(...plan.files.create);
    edit.push(...plan.files.edit);
    del.push(...plan.files.del);
  }
  const dedup = (files: string[]): string[] => [...new Set(files.map((f) => f.trim()).filter(Boolean))].slice(0, 12);
  const lines = [`Goal: ${plan.goal}`, '', 'Implementation:'];
  plan.steps
    .filter((s) => s.type !== 'run' && s.type !== 'verify')
    .forEach((s, i) => lines.push(`${i + 1}. ${s.description}`));
  const validations = plan.steps.filter((s) => s.type === 'run' || s.type === 'verify');
  if (validations.length > 0) {
    lines.push('', 'Validation:');
    validations.forEach((s, i) => lines.push(`${i + 1}. Run: ${s.description.replace(/^run\s*:?\s*/i, '')}`));
  }
  return {
    summary: plan.goal,
    steps,
    files: { create: dedup(create), edit: dedup(edit), del: dedup(del) },
    runs: runs.slice(0, 8),
    risks: '',
    constraints: [],
    raw: lines.join('\n'),
    ...(plan.text ? { presented: plan.text } : {}),
  };
}

/** Stack-aware verification hint so the plan can include a grounded `Run:` step. */
function verificationHintFor(cwd: string, stacks?: readonly { readonly test?: readonly string[] }[] | null): string {
  try {
    const declared = (stacks ?? [])
      .map((s) => (Array.isArray(s?.test) ? (s.test as readonly string[]).join(' ').trim() : ''))
      .find((cmd) => cmd !== '');
    if (declared) {
      return `\nProject verification: the workspace declares "${declared}". Include "Run: ${declared} — runs the project test suite" as the final step unless the request needs no verification.`;
    }
    if (typeof cwd !== 'string' || cwd.trim() === '') return '';
    const pkgPath = path.resolve(cwd, 'package.json');
    const raw = fs.readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const test = pkg?.scripts?.test;
    if (typeof test === 'string' && test.trim() && !/no test specified/i.test(test)) {
      return `\nProject verification: the workspace declares an "npm test" script. Include "Run: npm test — runs the project test suite" as the final step unless the request needs no verification.`;
    }
  } catch {
    /* no manifest or unreadable — no hint, never a guess */
  }
  return '';
}

/**
 * Ground create-vs-edit against the filesystem. Unknown states (EACCES,
 * ENOTDIR, …) are never promoted into `create`.
 */
async function groundFileClassification(plan: LegacyPlan, scope: string): Promise<LegacyPlan> {
  const { statType } = await import('../../tool/filesystem/_fs.ts');
  const hintedCreate = new Set(plan.files.create ?? []);
  const candidates = [...new Set([...hintedCreate, ...(plan.files.edit ?? [])])];
  if (candidates.length === 0) return plan;

  const create: string[] = [];
  const edit: string[] = [];

  for (const file of candidates) {
    let type: { type: 'file' | 'dir' | 'symlink'; size: number; mode: number } | null = null;
    let failed = false;
    try {
      type = await statType(path.resolve(scope, file));
    } catch {
      failed = true;
    }

    if (failed) {
      if (!hintedCreate.has(file)) edit.push(file);
      continue;
    }

    if (type === null) {
      create.push(file);
    } else if (type.type === 'file') {
      edit.push(file);
    }
  }

  return {
    ...plan,
    files: {
      ...plan.files,
      create: [...new Set(create)],
      edit: [...new Set(edit)],
    },
  };
}
