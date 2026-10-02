import { STOP_REASONS, type StopReason, NOT_ATTEMPTED_CODES, TOOL_ERROR_CODE } from '../../protocol';
import type { ToolResult, ToolCall } from '../../types';
import { signatureOf, type ToolCallRecord, type TurnState } from './turn-state';

import { fileTargetArg } from '../../tool/index';
import { callSignature } from '../router/memo';
import { defaultRegistry } from '../../tool/execution/registry';

export type ToolDecision =
  | { kind: 'EXECUTE' }
  | { kind: 'REUSE'; priorResult: ToolResult; reason: string }
  | { kind: 'REJECT'; reason: string; hint: string }
  | { kind: 'STOP'; reason: StopReason };

function actuallyRan(call: ToolCallRecord): boolean {
  if (call.isRepeat) return false;
  const code = call.result?.code;
  if (!code) return true;
  return !NOT_ATTEMPTED_CODES.includes(code as (typeof NOT_ATTEMPTED_CODES)[number]);
}

/** A reused result must not look identical to a fresh one, or the model is asked again with no
 *  way to tell that nothing ran. The notice is part of what the model reads. */
function reusedResult(prior: ToolResult, reason: string, hint?: string): ToolResult {
  return {
    ...prior,
    display: `Reused — ${reason}. The tool was not run again.\n${prior.display ?? ''}`,
    ...(hint ? { hint } : {}),
    // Saying what was reused is not enough for every model: the next step is what breaks the repeat.
    ...(prior.ok
      ? { modelNote: 'You already had this result; asking again returns it again. Act on it now — make the change it points to, or answer.' }
      : {}),
    data: { ...(prior.data ?? {}), reused: true },
  };
}

export function decideToolExecution(
  call: ToolCall,
  turnState: TurnState,
  workspaceState: { mutationCount?: number; targetStamp?: string } = {}
): ToolDecision {
  const callId = String(call.id ?? '');
  const name = String(call.function?.name ?? '');
  const args = (call.function?.arguments ?? {}) as Record<string, unknown>;
  const world = Number(workspaceState.mutationCount ?? 0);
  const targetKey = fileTargetArg(name, args);
  const target = targetKey ? String(args[targetKey] ?? '') || null : null;
  const providedTargetStamp = workspaceState.targetStamp;
  const signature = callSignature(name, args);
  const sameCall = (c: ToolCallRecord): boolean => signatureOf(c) === signature;

  const settledById = turnState.toolCalls.find((c) => c.callId === callId);
  if (settledById && !sameCall(settledById)) {
    return { kind: 'STOP', reason: STOP_REASONS.GUARD_STUCK };
  }

  // A request whose target now looks exactly as it did the last time this same request succeeded
  // has already had its effect, so running it again cannot change anything — no matter what else
  // has moved since. This is what stops a call from invalidating its own repetition: the world
  // advances when the call runs, and the world alone would license the identical retry.
  // A volatile tool's result can change while the project stays the same (a process, the clock, the person),
  // so its tool definition asks for every call to run; an earlier result is never handed back for it.
  const volatile = defaultRegistry.find(name)?.volatile === true;

  const settled = target == null || volatile
    ? undefined
    : turnState.toolCalls.find(
        (c) =>
          sameCall(c) &&
          actuallyRan(c) &&
          c.result?.ok &&
          c.target === target &&
          c.afterStamp != null &&
          c.afterStamp === providedTargetStamp &&
          (c.result.data as { idempotent?: unknown } | undefined)?.idempotent !== false,
      );

  if (settled) {
    const reason = `${name} already produced this exact result for ${target}`;
    return { kind: 'REUSE', priorResult: reusedResult(settled.result, reason), reason };
  }

  // The same call, succeeded, with nothing moved since. A call about no file is matched on the
  // workspace alone; one about a file also needs that file to look as it did then.
  const unchangedSince = (c: ToolCallRecord): boolean => {
    if (target == null) {
      return typeof providedTargetStamp === 'string' ? actuallyRan(c) && c.targetStamp === providedTargetStamp : true;
    }
    return actuallyRan(c) && c.target === target && (providedTargetStamp == null || c.targetStamp === providedTargetStamp);
  };
  const prior = volatile
    ? undefined
    : turnState.toolCalls.find((c) => sameCall(c) && Boolean(c.result?.ok) && c.world === world && unchangedSince(c));

  if (prior) {
    const reason = `${name} already ran with these exact arguments this turn`;
    return { kind: 'REUSE', priorResult: reusedResult(prior.result, reason), reason };
  }

  // A refusal that only loaded the schema is not an attempt the model has already made.
  // Counting it would lock the tool for the rest of the turn, which is the opposite of
  // what refusing it was for.
  const attempted = (c: (typeof turnState.toolCalls)[number]): boolean => !c.schemaPending;

  const priorFailed = turnState.toolCalls.find(
    (c) =>
      attempted(c) &&
      sameCall(c) &&
      actuallyRan(c) &&
      !c.result?.ok &&
      c.world === world &&
      c.result?.code &&
      (c.result.code === TOOL_ERROR_CODE.EINVAL ||
        c.result.code === TOOL_ERROR_CODE.EAMBIGUOUS ||
        c.result.code === TOOL_ERROR_CODE.ENOMATCH ||
        c.result.code === TOOL_ERROR_CODE.EDENIED)
  );

  const priorDeclined = turnState.toolCalls.find(
    (c) =>
      attempted(c) &&
      sameCall(c) &&
      !actuallyRan(c) &&
      !c.result?.ok &&
      c.world === world
  );

  if (priorFailed || priorDeclined) {
    return {
      kind: 'REJECT',
      reason: `${name} was already tried this turn and will not be retried with the same arguments`,
      hint: priorFailed
        ? 'The same step already failed. Change the approach or arguments before trying again.'
        : 'It did not run. Do not call it again with the same arguments; say what you need or ask the user with ask_user.',
    };
  }

  return { kind: 'EXECUTE' };
}