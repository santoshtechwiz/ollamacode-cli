import path from 'node:path';
import { APPROVAL } from '../../protocol';
import { logger } from '../../core/logger';
import { classifyTool, dangerousReason, normalizeToolName, refusalReason } from './mutation-policy';
import { isInPlan, type PlanLike } from './state-policy';
import { workspaceFor } from '../../agent/workspace/manager';
import type { ToolDef } from '../../types';

export type ApprovalVerdict = typeof APPROVAL.UNAVAILABLE | typeof APPROVAL.REFUSED | typeof APPROVAL.CANCELLED | boolean;

export type ApproveFn = (
  toolName: string,
  args: Record<string, unknown>,
  def: ToolDef,
  reason?: { outside?: string[]; outsideScope?: string[]; dangerous?: string | null; unplanned?: string; planScope?: string }
) => Promise<ApprovalVerdict>;

export type AnswerFn = (
  question: string,
  options?: string[],
  opts?: { accepts?: (answer: string) => boolean; signal?: AbortSignal }
) => Promise<string>;

export interface PermissionState {
  alwaysAllowTools: Set<string>;
  /** The person answered "always": routine calls of every tool are approved for the session, not only that tool's. */
  alwaysAllowAll?: boolean;
  deniedTools: Set<string>;
}

export function createPermissions(): PermissionState {
  return {
    alwaysAllowTools: new Set<string>(),
    deniedTools: new Set<string>(),
  };
}

function isAlwaysAllowed(
  permissions: PermissionState | undefined | null,
  toolName: string,
): boolean {
  return Boolean(permissions?.alwaysAllowAll || permissions?.alwaysAllowTools?.has(toolName));
}

export function clearAlwaysAllow(permissions: PermissionState): void {
  permissions.alwaysAllowTools.clear();
  permissions.alwaysAllowAll = false;
}

export function persistentPermissions(
  permissions: PermissionState,
): {
  alwaysAllowAll: boolean;
  alwaysAllowTools: string[];
} {
  return {
    alwaysAllowAll: false,
    alwaysAllowTools: [...permissions.alwaysAllowTools],
  };
}

export function permissionsFromRecord(
  saved: unknown,
): PermissionState | null {
  if (!saved || typeof saved !== 'object') {
    return null;
  }

  const record = saved as Record<string, unknown>;

  if (!Array.isArray(record.alwaysAllowTools)) {
    return null;
  }

  const alwaysAllowTools = new Set(
    record.alwaysAllowTools.filter(
      (tool): tool is string =>
        typeof tool === 'string' && tool.trim().length > 0,
    ),
  );

  if (alwaysAllowTools.size === 0) {
    return null;
  }

  return {
    alwaysAllowTools,
    deniedTools: new Set<string>(),
  };
}

export type PermissionDecision = 'allow' | 'deny' | 'ask' | 'always';

export interface PermissionContext {
  toolName: string;
  args: Record<string, unknown>;
  toolDef: ToolDef;
  cwd: string;
  root: string;
  plan?: PlanLike;
  permissions: PermissionState;
  yes: boolean;
  policy: 'ask' | 'always' | 'never';
  interactive: boolean;
  /** Paths the user already let in this session count as inside the workspace. */
  grantedRoots?: string[];
}

export interface PermissionRule {
  name: string;
  evaluate(ctx: PermissionContext): Promise<PermissionDecision | null> | PermissionDecision | null;
}

export function outsidePaths(def: ToolDef, args: Record<string, unknown>, ctx: { cwd: string; root: string; ws?: any }): string[] {
  const keys = Object.keys(def.parameters.properties ?? {}).filter(
    (k) => (def.parameters.properties?.[k] as any)?.pathArg === true,
  );
  if (keys.length === 0 || !ctx) return [];

  const ws = ctx.ws ?? workspaceFor({ root: ctx.root, cwd: ctx.cwd } as any);
  const out: string[] = [];

  for (const key of keys) {
    const raw = args[key];
    if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0')) continue;
    try {
      ws.resolveLexical(raw);
    } catch {
      const resolved = path.resolve(ctx.root, raw);
      if (!out.includes(resolved)) out.push(resolved);
    }
  }
  return out;
}

function dangerOf(def: ToolDef, args: Record<string, unknown>, ctx: { cwd: string; root: string }): string | null {
  if (!def.dangerReason) return null;
  try {
    return def.dangerReason(args, { cwd: ctx.cwd, root: ctx.root });
  } catch (err) {
    logger.debug(`dangerReason threw for ${def.name}:`, err);
    return 'could not determine whether this is dangerous — confirm before running';
  }
}

export function confirmOf(def: ToolDef, args: Record<string, unknown>, ctx: { cwd: string; root: string }): string | null {
  try {
    return def?.confirmReason?.(args, { cwd: ctx.cwd, root: ctx.root }) ?? null;
  } catch (err) {
    logger.debug(`confirmReason threw for ${def?.name}:`, err);
    return 'could not tell what this changes — confirm before running';
  }
}

/** The shell command a call runs, when its tool declares one; the checks below read the command, never the tool's name. */
function shellCommandOf(ctx: PermissionContext): string | null {
  const key = ctx.toolDef?.shellCommand;
  return key ? String(ctx.args?.[key] ?? '') : null;
}

class HardRefusalRule implements PermissionRule {
  name = 'hard-refusal';
  async evaluate(ctx: PermissionContext): Promise<PermissionDecision | null> {
    const command = shellCommandOf(ctx);
    if (command !== null && refusalReason(command)) {
      return 'deny';
    }
    return null;
  }
}

class ScopeEscapeRule implements PermissionRule {
  name = 'scope-escape';
  async evaluate(ctx: PermissionContext): Promise<PermissionDecision | null> {
    const outside = outsidePaths(ctx.toolDef, ctx.args, { cwd: ctx.cwd, root: ctx.root, ws: workspaceFor({ root: ctx.root, cwd: ctx.cwd, state: { grantedRoots: ctx.grantedRoots ?? [] } }) });
    if (outside.length > 0) {
      if (!ctx.interactive) {
        return 'deny';
      }
      return 'ask';
    }
    return null;
  }
}

/** Classified from the tool's own definition, which this context carries; without it every tool not on the
 *  built-in lists read as unknown, and a task-list update asked for approval like a file write. */
function classifyOwn(ctx: PermissionContext): 'read-only' | 'mutating' {
  return classifyTool(ctx.toolName, ctx.args, {
    cwd: ctx.cwd,
    root: ctx.root,
    ...(ctx.toolDef ? { meta: { [normalizeToolName(ctx.toolName)]: ctx.toolDef } } : {}),
  });
}

class PlanGateRule implements PermissionRule {
  name = 'plan-gate';
  evaluate(ctx: PermissionContext): PermissionDecision | null {
    const classification = classifyOwn(ctx);

    if (classification === 'mutating' && ctx.plan) {
      try {
        const inPlan = isInPlan(ctx.plan, ctx.toolName, ctx.args);
        if (!inPlan) {
          // --yes means the session pre-approves; a plan that has been approved must not
          // deadlock the work it was approved for.
          if (ctx.yes) {
            return 'allow';
          }
          if (ctx.policy === 'always') {
            return ctx.interactive && askedEveryTime(ctx) ? 'ask' : 'allow';
          }
          if (!ctx.interactive) {
            return 'deny';
          }
          return 'ask';
        }
      } catch (err) {
        logger.debug(`isInPlan threw for ${ctx.toolName}:`, err);
        return 'deny';
      }
    }
    return null;
  }
}

class DangerousToolRule implements PermissionRule {
  name = 'dangerous-tool';
  async evaluate(ctx: PermissionContext): Promise<PermissionDecision | null> {
    const danger = dangerOf(ctx.toolDef, ctx.args, { cwd: ctx.cwd, root: ctx.root });
    if (danger) {
      return 'ask';
    }
    const command = shellCommandOf(ctx);
    if (command !== null && dangerousReason(command, ctx.cwd)) {
      return 'ask';
    }
    return null;
  }
}

/** Deletes, git writes and dangerous commands are asked about every time: no standing approval covers them. */
function askedEveryTime(ctx: PermissionContext): boolean {
  const where = { cwd: ctx.cwd, root: ctx.root };
  if (dangerOf(ctx.toolDef, ctx.args, where) || confirmOf(ctx.toolDef, ctx.args, where)) return true;
  const command = shellCommandOf(ctx);
  return command !== null && Boolean(dangerousReason(command, ctx.cwd));
}

class StandingGrantRule implements PermissionRule {
  name = 'standing-grant';
  evaluate(ctx: PermissionContext): PermissionDecision | null {
    if (isAlwaysAllowed(ctx.permissions, ctx.toolName)) {
      // A standing grant covers only the routine calls.
      if (askedEveryTime(ctx)) {
        return null;
      }
      return ctx.permissions.alwaysAllowTools.has(ctx.toolName) ? 'always' : 'allow';
    }
    return null;
  }
}

class PolicyDefaultRule implements PermissionRule {
  name = 'policy-default';
  evaluate(ctx: PermissionContext): PermissionDecision | null {
    const classification = classifyOwn(ctx);

    if (classification === 'read-only') {
      return 'allow';
    }

    if (ctx.policy === 'never') {
      return 'deny';
    }

    // The "always" policy is a standing approval for the whole session: like a grant, it covers routine calls only,
    // and someone who is there is still asked before a delete or a git write.
    if (ctx.policy === 'always') {
      return ctx.interactive && askedEveryTime(ctx) ? 'ask' : 'allow';
    }

    if (ctx.yes) {
      return 'allow';
    }

    if (!ctx.interactive) {
      return 'deny';
    }

    return 'ask';
  }
}

const DEFAULT_RULES: PermissionRule[] = [
  // Refusals come first and are never grantable: a fork bomb stays refused whatever the user allowed.
  new HardRefusalRule(),
  new ScopeEscapeRule(),
  // A dangerous call is asked about every time. A grant cannot pre-approve one, so this must also
  // run before the grant is read, or "always" would quietly arm a destructive command.
  new DangerousToolRule(),
  // The grant is read before the plan gate. Pressing `a` is the user saying "stop asking about
  // this tool", which is a more direct answer than a plan that happens to be active — and with the
  // gate first, a grant was silently ignored for the whole of plan work, which is what "always
  // never works" looked like from the chair.
  new StandingGrantRule(),
  new PlanGateRule(),
  new PolicyDefaultRule(),
];

export class PermissionPolicy {
  private rules: PermissionRule[];

  constructor(rules: PermissionRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  async decide(ctx: PermissionContext): Promise<PermissionDecision> {
    for (const rule of this.rules) {
      const decision = await rule.evaluate(ctx);
      if (decision !== null) {
        return decision;
      }
    }
    return 'deny';
  }

  addRule(rule: PermissionRule): this {
    this.rules.push(rule);
    return this;
  }

  static createDefault(): PermissionPolicy {
    return new PermissionPolicy([...DEFAULT_RULES]);
  }
}

export function readVerdict(verdict: unknown): { allowed: boolean; unasked: boolean; refused: boolean; cancelled: boolean; declined: boolean; } {
  const known =
    verdict === true ||
    verdict === false ||
    verdict === APPROVAL.UNAVAILABLE ||
    verdict === APPROVAL.REFUSED ||
    verdict === APPROVAL.CANCELLED ||
    verdict === 'always';
  return {
    allowed: verdict === true || verdict === 'always',
    unasked: verdict === APPROVAL.UNAVAILABLE,
    refused: verdict === APPROVAL.REFUSED,
    // An answer nobody gave is not a refusal, and calling it one told the user they had
    // rejected work they never saw. Anything unrecognised counts as unanswered too.
    cancelled: verdict === APPROVAL.CANCELLED || !known,
    declined: verdict === false,
  };
}

/** A decline only speaks for the turn it happened in. */
export function clearDenials(permissions: PermissionState | undefined | null): void {
  permissions?.deniedTools?.clear();
}

export function applyApprovalPolicy(state: { permissions?: PermissionState; autoFixAuthorized?: boolean } | null | undefined, { yes = false, policy = 'ask' }: { yes?: boolean; policy?: string; } = {}) {
  if (!state) return;
  if (policy === 'never') {
    if (state.permissions) clearAlwaysAllow(state.permissions);
    state.autoFixAuthorized = false;
    return;
  }
  state.autoFixAuthorized = yes || policy === 'always';
}