import { TOOL_RESULT_STATUS, statusForCode, TOOL_ERROR_CODE, isTransient, EPHEMERAL_SESSION } from '../../protocol';
import type { ApprovalVerdict } from '../../protocol';

import { fail, fromError, clamp } from '../core/tool-result';
import { logger } from '../../core/logger';
import { isCancel } from '../../core/errors';
import { sleep } from '../../model/providers/http';
import { PermissionPolicy, createPermissions, readVerdict, outsidePaths } from '../policy/permission-policy';
import { workspaceFor } from '../../agent/workspace/manager';
import { pathArgsOf, resolvePathArgs } from '../core/paths';
import { repeatedInvalidMessage } from '../../agent/router/memo';
import { prepareCall } from './prepare';
import { describeCall } from '../core/tool-call';
import { fileTargetArg, targetPathArg } from '../common/wired-policy';
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

    // A call the tool already knows will fail is refused before anyone is asked to approve it.
    // Paths outside the workspace are looked at only once approved, since a refusal may quote the file.
    const outside = outsidePaths(def as ToolDef, args, context);
    const refusal = outside.length === 0 ? await cannotRun(def as ToolDef, args, context) : null;
    if (refusal) return record(refusal);

    const permissions = context.state?.permissions ?? createPermissions();
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
      const verdict = await approve(resolved, args, def as ToolDef, { dangerous: null, ...(outside.length ? { outside } : {}) });
      const { allowed, cancelled, refused } = readVerdict(verdict);
      if (!allowed) {
        if (refused) return record(fail(`the session's permission policy forbids ${resolved}`, { code: TOOL_ERROR_CODE.EPOLICY }));
        if (cancelled) return record(fail(`${resolved} was not answered, so it did not run`, { code: TOOL_ERROR_CODE.EDENIED }));
        return record(fail('Action rejected by user', { code: TOOL_ERROR_CODE.EDENIED }));
      }
      // Approving a path outside the workspace is what opens it: exactly those paths, for the rest of the session.
      for (const p of outside) {
        context.ws.grant(p);
        context.state?.grant?.(p);
      }
    } else if (decision === 'deny') {
      return record(fail(`${resolved} was blocked by the session permission policy`, { code: TOOL_ERROR_CODE.EDENIED }));
    }
    if (outside.length > 0) {
      const late = await cannotRun(def as ToolDef, args, context);
      if (late) return record(late);
    }

    try {
      ({ args: runArgs } = await resolvePathArgs(def as ToolDef, args, context.ws));
      // Revalidate after approval to close a symlink-swap window.
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

    // Stage a pre-image for restorable file mutations; never block on failure.
    let pending: PendingRecovery | null = null;
    // Synthetic contexts carry no ledger; treat as ephemeral.
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

      // Path arg comes from schema so memo scope expires correctly.
      const scopeKey = targetPathArg(resolved);
      const scopePath = scopeKey && typeof (runArgs as any)?.[scopeKey] === 'string'
        ? String((runArgs as any)[scopeKey])
        : null;
      memo?.note(resolved, args, result, scopePath);
      if (result.ok && def?.runsCode) memo?.invalidateAll();
      // A tool that may change things without naming the file (a shell, a script, git) may have changed anything on disk,
      // whether or not it succeeded, so the workspace has moved: an earlier read or listing is no longer the current one.
      // File tools move it themselves when they record the change.
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
      // `def` is undefined for unknown-tool early returns — fall back to a synthetic def so logging/ledger never crash on `preview`.
      const effectiveDef: ToolDef = (def ?? ({ name: resolved } as unknown as ToolDef));
      // Attach the file path to failures that omit it.
      const result = (() => {
        if (raw?.data?.path) return raw;
        const key = effectiveDef ? pathArgsOf(effectiveDef as any)[0] : undefined;
        const named = key && key !== 'cwd' ? (args as any)[key] : undefined;
        if (typeof named !== 'string' || named === '') return raw;
        return { ...raw, data: { ...(raw.data ?? {}), path: named } };
      })();

      // Single choke point for logging and ledger recording.
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

/** The tool's own check for a call that would fail before changing anything; a check that throws decides nothing. */
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
  if (result && typeof result === 'object' && typeof ( (result as any).ok) === 'boolean') {
    const r = (result as ToolResult);
    // Fill in status from code when the tool omits it.
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

/** The executor every live call runs through. */
export const runtime = new ToolRuntime();
