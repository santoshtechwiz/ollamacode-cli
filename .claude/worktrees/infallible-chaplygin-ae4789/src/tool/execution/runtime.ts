import path from 'node:path';
import { TOOL_RESULT_STATUS, statusForCode, TOOL_ERROR_CODE, isTransient, EPHEMERAL_SESSION, STORAGE } from '../../protocol';
import type { ApprovalVerdict } from '../../protocol';

import { fail, fromError, clamp } from '../core/tool-result';
import { logger } from '../../core/logger';
import { isCancel } from '../../core/errors';
import { sleep } from '../../model/providers/http';
import {
  PermissionPolicy,
  createPermissions,
  readVerdict,
  outsidePaths,
  denyToolCall,
  isDeniedToolCall,
} from '../policy/permission-policy';
import { shellWritesOutside } from '../policy/mutation-policy';
import { workspaceFor } from '../../agent/workspace/manager';
import { pathArgsOf, resolvePathArgs } from '../core/paths';
import { repeatedInvalidMessage } from '../../agent/router/memo';
import { prepareCall } from './prepare';
import { describeCall } from '../core/tool-call';
import { classifyCall, fileTargetArg, targetPathArg } from '../common/wired-policy';
import { stageRecovery, commitRecovery, discardRecovery } from '../../core/session-recovery';
import type { PendingRecovery } from '../../core/session-recovery';

import type { ToolContextInput, ToolResult, ToolDef } from '../../types';
import { defaultRegistry, type ToolRegistry } from './registry';

const RETRY_DELAY_MS = 250;

export type ExecuteApprove = (
  toolName: string,
  args: Record<string, unknown>,
  def: ToolDef,
  reason?: {
    outside?: string[];
    outsideScope?: string[];
    dangerous?: string | null;
    unplanned?: string;
    planScope?: string;
  },
) => Promise<ApprovalVerdict>;

function denialTargetFor(toolName: string, args: Record<string, unknown>): string | null {
  const key = targetPathArg(toolName) ?? pathArgsOf({ name: toolName, parameters: { properties: {} } } as ToolDef)[0] ?? null;
  if (!key || typeof (args as any)?.[key] !== 'string') {
    const first = Object.values(args ?? {}).find((value) => typeof value === 'string');
    return typeof first === 'string' && first.trim() ? first : null;
  }
  return String((args as any)[key]);
}

// Single choke point for every tool call.
export class ToolRuntime {
  constructor(readonly registry: ToolRegistry = defaultRegistry) {}

  async run(name: string, rawArgs: Record<string, unknown> | undefined, ctx: ToolContextInput, approve?: ExecuteApprove): Promise<ToolResult> {
    const root = ctx?.root ?? ctx?.cwd ?? process.cwd();
    const context = { ...ctx, root, cwd: ctx?.cwd ?? root, ws: workspaceFor(ctx) };
    let runArgs: Record<string, unknown> | undefined;

    // Same passes the loop runs before prompting; pure so re-running is free.
    const prepared = prepareCall(name, rawArgs, this.registry);
    const { resolved } = prepared;
    // `prepared.def` is undefined for unknown tools — keep it optional so early returns (Unknown tool, validation) do not crash on `def.preview`.
    const def: ToolDef | undefined = (prepared as any).def as ToolDef | undefined;
    const args = prepared.args;

    const memo = context.memo;
    const priorRejection = memo?.recall(resolved, args);
    if (priorRejection) {
      return record(
        fail(repeatedInvalidMessage(resolved, priorRejection), {
          code: (priorRejection.code as any),
          hint: priorRejection.hint ?? 'Change the arguments, or use a different tool.',
          display: priorRejection.display,
          note: `the same ${resolved} call was rejected before — it was not run again`,
        })
      );
    }

    if (!prepared.ok) {
      memo?.note(resolved, args, prepared.result);
      return record(prepared.result);
    }

    const permissions = context.state?.permissions ?? createPermissions();
    const denialTarget = denialTargetFor(resolved, args);
    if (isDeniedToolCall(permissions, resolved, args, denialTarget)) {
      return record(fail(
        `${resolved} was denied earlier in this turn — the same action will not be re-run`,
        {
          code: TOOL_ERROR_CODE.EPOLICY,
          hint: 'The user explicitly rejected this exact action. Pick a different operation or ask for a new plan.',
        },
      ));
    }

    // A mode or moment that only looks changes nothing, whatever the model calls: the tool list it was offered is a
    // hint, this is the rule. Plan mode while it explores, Ask/Review mode, and a turn whose plan was shown but not started.
    const changes = classifyCall(resolved, args, { cwd: context.cwd, root: context.root, def }) === 'mutating';
    const lookOnly = changes && (def as ToolDef).writesFiles !== false ? lookOnlyReason(context.state) : null;
    if (lookOnly) {
      return record(fail(`${resolved} changes things, and ${lookOnly} — not run`, {
        code: TOOL_ERROR_CODE.EBLOCKED,
        hint: 'Read, search and answer only. Say what you would change instead of changing it.',
      }));
    }

    // git's own folder and ocode's are never changed through a file tool: a file in .git/hooks runs on the next git
    // command, and ocode's records are its own. Reading them is fine; the git tool is the way to change a repository.
    const ownData = changes ? protectedTarget(def as ToolDef, args, context.root) : null;
    if (ownData) {
      return record(fail(`${resolved} would change ${ownData}, which belongs to ${ownData.split('/').includes('.git') ? 'git' : 'ocode'} — not run`, {
        code: TOOL_ERROR_CODE.EBLOCKED,
        hint: 'Leave .git/ and .ollamacode/ alone; use the git tool to change the repository.',
      }));
    }

    // A call the tool already knows will fail is refused before anyone is asked to approve it.
    // Paths outside the workspace are looked at only once approved, since a refusal may quote the file.
    const outside = outsidePaths(def as ToolDef, args, context);
    const refusal = outside.length === 0 ? await cannotRun(def as ToolDef, args, context) : null;
    if (refusal) return record(refusal);

    const decision = await new PermissionPolicy().decide({
      toolName: resolved,
      args,
      toolDef: def as ToolDef,
      cwd: context.cwd,
      root: context.root,
      plan: context.state?.plan ?? undefined,
      permissions,
      yes: Boolean(context.state?.autoFixAuthorized),
      policy: 'ask',
      interactive: Boolean(approve),
      grantedRoots: context.ws.grants(),
    });
    if (decision === 'ask') {
      if (!approve) return record(fail(`${resolved} requires approval, but no approval handler is available`, { code: TOOL_ERROR_CODE.EDENIED }));
      const command = def?.shellCommand ? String(args?.[def.shellCommand] ?? '') : '';
      const shellOutside = command && !outside.length ? shellWritesOutside(command, context.cwd, [context.root, ...context.ws.grants()]) : null;
      const shown = shellOutside ? [shellOutside] : outside;
      const verdict = await approve(resolved, args, def as ToolDef, { dangerous: null, ...(shown.length ? { outside: shown } : {}) });
      const { allowed, cancelled, refused, unasked, declined } = readVerdict(verdict);
      if (!allowed) {
        denyToolCall(permissions, resolved, args, denialTarget);
        if (refused) {
          const escaped = shown.length ? shown.join(', ') : null;
          return record(fail(
            escaped
              ? `${resolved} reaches outside the workspace (${escaped}) — not run; only an approval in the chat or --scope <dir> allows that`
              : `${resolved} is not allowed by this session's permission settings — not run`,
            { code: TOOL_ERROR_CODE.EPOLICY },
          ));
        }
        if (cancelled) return record(fail(`${resolved} was not answered, so it did not run`, { code: TOOL_ERROR_CODE.EDENIED }));
        if (unasked) return record(fail(`${resolved} needs approval, and this run has nobody to ask — not run`, { code: TOOL_ERROR_CODE.EDENIED, hint: 'Run ocode in a terminal to approve it when it is ready.' }));
        if (declined) return record(fail('Action rejected by user', { code: TOOL_ERROR_CODE.EDENIED }));
        return record(fail('Action rejected by user', { code: TOOL_ERROR_CODE.EDENIED }));
      }
      for (const p of outside) {
        context.ws.grant(p);
        context.state?.grant?.(p);
      }
    } else if (decision === 'deny') {
      denyToolCall(permissions, resolved, args, denialTarget);
      return record(fail(`${resolved} was blocked by the session permission policy`, { code: TOOL_ERROR_CODE.EDENIED }));
    }
    if (outside.length > 0) {
      const late = await cannotRun(def as ToolDef, args, context);
      if (late) return record(late);
    }

    try {
      ({ args: runArgs } = await resolvePathArgs(def as ToolDef, args, context.ws));
      for (const key of pathArgsOf(def as ToolDef)) {
        const value = runArgs[key];
        if (typeof value === 'string') await context.ws.resolve(value);
      }
    } catch (err) {
      const bad = fromError(err);
      memo?.note(resolved, args, bad);
      return record(bad);
    }

    if (ctx?.signal?.aborted) {
      return record(fail('Cancelled before execution', { code: TOOL_ERROR_CODE.ECANCELLED }));
    }

    let pending: PendingRecovery | null = null;
    const ledgerSession = context.state?.sessionId ?? EPHEMERAL_SESSION;
    if ((def as ToolDef).restorable === true) {
      const targetKey = fileTargetArg(resolved, args);
      const target = targetKey && runArgs ? runArgs[targetKey] : undefined;
      if (typeof target === 'string') {
        try {
          pending = await stageRecovery({
            root: context.ws.root,
            sessionId: ledgerSession,
            tool: resolved,
            abs: target,
            rel: context.ws.rel(target),
          });
        } catch (err) {
          logger.debug(`recovery stage failed for ${resolved}:`, err);
        }
      }
    }

    let retries = 0;
    for (;;) {
      let result: ToolResult;
      try {
        logger.debug(`tool ${resolved}`, JSON.stringify(args).slice(0, 300));
        result = coerceResult(await (def as ToolDef).execute(runArgs, context), resolved);
      } catch (err) {
        if (isCancel(err)) {
          await discardRecovery(pending);
          return record(fail('Cancelled', { code: TOOL_ERROR_CODE.ECANCELLED }), retries);
        }
        logger.debug(`tool ${resolved} threw:`, err);
        result = fromError(err);
      }

      const scopeKey = targetPathArg(resolved);
      const scopePath = scopeKey && typeof (runArgs as any)?.[scopeKey] === 'string'
        ? String((runArgs as any)[scopeKey])
        : null;
      memo?.note(resolved, args, result, scopePath);
      if (result.ok && def?.runsCode) memo?.invalidateAll();
      if ((def?.risky || def?.runsCode) && fileTargetArg(resolved, args) === null) context.state?.touch?.();
      const retryable = !result.ok && result.code && isTransient(result.code);
      if (!retryable || retries > 0 || ctx?.signal?.aborted) {
        if (result.ok) {
          await commitRecovery({ root: context.ws.root, sessionId: ledgerSession }, pending);
        } else {
          await discardRecovery(pending);
        }
        return record(result, retries);
      }

      retries += 1;
      logger.debug(`tool ${resolved} hit ${result.code}; retrying once`);
      await sleep(RETRY_DELAY_MS);
    }

    function record(raw: ToolResult, spent: number = 0): ToolResult {
      const effectiveDef: ToolDef = (def ?? ({ name: resolved } as unknown as ToolDef));
      const result = (() => {
        if (raw?.data?.path) return raw;
        const key = effectiveDef ? pathArgsOf(effectiveDef as any)[0] : undefined;
        const named = key && key !== 'cwd' ? (args as any)[key] : undefined;
        if (typeof named !== 'string' || named === '') return raw;
        return { ...raw, data: { ...(raw.data ?? {}), path: named } };
      })();

      if (logger.enabled('trace')) {
        logger.traceBlock(
          `tool ${resolved}${spent ? ` (retried ${spent})` : ''}`,
          JSON.stringify({ args: runArgs, ok: result.ok, code: result.code, error: result.error, display: result.display, data: result.data }, null, 2)
        );
      }
      ctx?.state?.record?.({
        name: resolved,
        summary: describeCall(effectiveDef as any, args).slice(0, 160),
        ok: result.ok,
        code: result.code,
        detail: firstLine(result.ok ? result.display : result.error),
        retries: spent,
      });
      return result;
    }
  }
}

function lookOnlyReason(state: any): string | null {
  if (state?.planExploring) return 'plan mode only looks until the plan is approved';
  if (state?.reviewOnly) return 'this mode only reads (switch to Agent mode to make changes)';
  if (state?.planHeld) return 'the plan shown this turn was not started';
  return null;
}

function protectedTarget(def: ToolDef, args: Record<string, unknown>, root: string): string | null {
  for (const key of pathArgsOf(def)) {
    const raw = args[key];
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const rel = path.relative(path.resolve(root), path.resolve(root, raw)).split(path.sep).join('/');
    const parts = rel.split('/');
    if (parts.includes('.git') || parts.includes(STORAGE.PROJECT_DIR)) return rel;
  }
  return null;
}

async function cannotRun(def: ToolDef, args: Record<string, unknown>, ctx: ToolContextInput): Promise<ToolResult | null> {
  if (!def.cannotRun) return null;
  try {
    return await def.cannotRun(args, ctx as any);
  } catch (err) {
    logger.debug(`cannotRun for ${def.name} threw:`, err);
    return null;
  }
}

function firstLine(text: string | undefined): string | undefined {
  const line = String(text ?? '').split('\n').find((l) => l.trim() !== '');
  return line ? clamp(line.trim(), 400).text : undefined;
}

function coerceResult(result: unknown, toolName: string): ToolResult {
  if (result && typeof result === 'object' && typeof ((result as any).ok) === 'boolean') {
    const r = (result as ToolResult);
    if (r.status) return r;
    return {
      ...r,
      status: r.ok
        ? TOOL_RESULT_STATUS.SUCCESS
        : (statusForCode(r.code) ?? TOOL_RESULT_STATUS.FAILED),
    };
  }
  if (typeof result === 'string') {
    logger.debug(`tool ${toolName} returned a bare string; coercing`);
    return { ok: true, kind: 'text', display: result, data: {}, status: TOOL_RESULT_STATUS.SUCCESS };
  }
  logger.debug(`tool ${toolName} returned a non-standard result (${typeof result}); treating as failure`);
  return fail(`${toolName} returned no usable result`, {
    code: TOOL_ERROR_CODE.EBADRESULT,
    data: (result ?? {} as Record<string, unknown>),
  });
}

export const runtime = new ToolRuntime();
