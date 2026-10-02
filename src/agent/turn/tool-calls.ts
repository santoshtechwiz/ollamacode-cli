// One pass over a reply's tool calls: prepare, decide, execute, then settle each call exactly once.

import { STOP_REASONS, TOOL_ERROR_CODE } from '../../protocol';
import type { ContextStore } from '../../context/contracts';
import type { ToolCall, ToolResult } from '../../types';
import { type ToolExecutor } from '../../tool/execution/executor';
import { prepareCall } from '../../tool/execution/prepare';
import { defaultRegistry } from '../../tool/execution/registry';
import type { ToolResolver } from '../../tool/execution/tool-resolver';
import { fail } from '../../tool/core/tool-result';
import { fileTargetArg } from '../../tool/index';
import { fileStamp } from '../../core/paths';
import { newId } from '../../core/ids';
import { isCancel } from '../../core/errors';
import { agentConfig } from '../../core/config';
import { logger } from '../../core/logger';
import type { ApproveFn } from '../../tool/policy/permission-policy';
import { compressToolOutput } from '../../context/result-compression';
import { renderToolResult } from '../router/render';
import { activityForTool } from '../status';
import { decideDiscovery, type DiscoveryDecision } from './tool-discovery';
import { decideToolExecution, type ToolDecision } from './tool-execution-decider';
import type { ProgressTracker, EvidenceType } from './progress-tracker';
import type { TurnState, ToolCallRecord } from './turn-state';
import type { TurnCallbacks } from './turn';

const DEFAULT_TOOL_OUTPUT_CHARS = 8000;

/** renderToolResult() opens a failure with `ERROR <name> [code] — reason` and nothing else does. */
const FAILED_RESULT = /^ERROR\b/;

/** Whether a rendered tool result, as the model read it, reports a failure. */
export function renderedAsFailure(rendered: string): boolean {
  return FAILED_RESULT.test(rendered);
}

interface ToolCallBatch {
  turnState: TurnState;
  history: ContextStore;
  callbacks: TurnCallbacks;
  toolRunner: ToolExecutor;
  progressTracker: ProgressTracker;
  workspaceState: any;
  toolsEnabled: boolean;
  toolsAllowed: boolean;
  /** Set only when a tool index is on the wire, with the names the model was shown; absent in text mode. */
  discovery?: { resolver: ToolResolver; onWire: ReadonlySet<string> };
  signal?: AbortSignal;
  approve?: ApproveFn;
}

type Decision = ToolDecision | DiscoveryDecision;

/** A call with its name resolved, its arguments prepared, and the file it is about. */
interface PreparedToolCall {
  call: ToolCall;
  prep: ReturnType<typeof prepareCall>;
  target: string | null;
  targetStamp: string | null;
}

/** What the model is shown for one call: the rendered result, cleaned and held to the shared output budget. */
function renderedFor(result: ToolResult, toolName: string, limit: number): string {
  return compressToolOutput(renderToolResult(result, toolName), limit);
}

/** Adds the assistant/tool pair to history and returns the exact text the model now sees for it. */
function recordExchange(history: ContextStore, call: ToolCall, result: ToolResult, limit: number): string {
  const settled: ToolCall = { ...call, id: call.id || newId() };
  history.addAssistant('', [settled]);
  const rendered = renderedFor(result, settled.function.name, limit);
  history.addToolResult(settled, rendered);
  return rendered;
}

/** Sorted args, so a log line reads the same however the model ordered the keys. */
function stableArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/** Why the decider chose what it chose. */
function explainDecision(decision: Decision, world: number, target: string | null): string {
  switch (decision.kind) {
    case 'UNVERIFIED':
    case 'DISCOVERED':
      return decision.kind.toLowerCase();
    case 'REUSE':
    case 'STOP':
      return decision.reason;
    case 'REJECT':
      return `${decision.reason} (${decision.hint})`;
    default: {
      const parts = [`no matching call at world ${world}`];
      if (target) parts.push(`target ${target} is at ${fileStamp(target) ?? 'absent'}`);
      if (world === 0) parts.push('nothing has mutated yet');
      return parts.join('; ');
    }
  }
}

/**
 * ProgressTracker receives explicit evidence. It does not classify tool names, parse shell
 * commands, count observations or retries, or decide whether a tool may execute: the execution
 * layer remains responsible for determining what actually happened.
 */
function progressTypeFor(name: string, result: ToolResult): EvidenceType | null {
  const intent = (result.data as { verification?: { intent?: string } } | undefined)?.verification?.intent;
  // A result that says it checked the project (a build, a test run) is verification, whichever tool produced it.
  if (intent && intent !== 'none') return 'verification';

  // What a tool can do is declared on its definition: one that may change things is a mutation, the rest observe; the agent's own bookkeeping tools are neither.
  const def = defaultRegistry.find(name);
  if (!def?.category || def.category === 'agent') return null;
  return def.risky || def.runsCode ? 'mutation' : 'observation';
}

function recordProgress(tracker: ProgressTracker, entry: ToolCallRecord): void {
  if (entry.isRepeat) return;
  const { name, result } = entry;
  const type = progressTypeFor(name, result);

  // Bookkeeping (the task list, memory) changes no file, but doing it is the model doing what it was
  // asked, so a round that only did bookkeeping is never read as a stall. Detecting a model that
  // repeats the *same* bookkeeping over and over is roundRepeatsEarlier's job, not this one's.
  if (!type) {
    if (result.ok) tracker.recordBookkeeping();
    return;
  }

  const passed = (result.data as { verification?: { passed?: boolean } } | undefined)?.verification?.passed;
  const success = type === 'verification' ? Boolean(passed ?? result.ok) : result.ok;
  tracker.recordResult(entry, type, success);
}

function prepareToolCall(call: ToolCall): PreparedToolCall {
  const prep = prepareCall(String(call.function?.name ?? ''), (call.function?.arguments ?? {}) as Record<string, unknown>);
  const name = prep.resolved;
  const args = prep.args;
  const targetKey = prep.ok ? fileTargetArg(name, args) : null;
  const target = targetKey ? String(args[targetKey] ?? '') || null : null;
  return {
    call: { ...call, id: String(call.id ?? newId()), function: { name, arguments: args } },
    prep,
    target,
    targetStamp: target ? fileStamp(target) : null,
  };
}

/** A refusal that never reached the tool. */
function notRun(error: string, code: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { ok: false, kind: 'text', error, code, ...extra } as ToolResult;
}

async function runTool(prepared: PreparedToolCall, batch: ToolCallBatch): Promise<ToolResult> {
  const { toolRunner, signal, approve } = batch;
  const outcome = await toolRunner.run(prepared.call.function.name, prepared.call.function.arguments, { signal, approve });
  return outcome.result;
}

/** The result a decision stands for, and whether a tool actually ran to produce it. */
async function resultForDecision(
  decision: Decision,
  prepared: PreparedToolCall,
  batch: ToolCallBatch,
): Promise<{ result: ToolResult; ran: boolean }> {
  const { callbacks, turnState } = batch;
  const name = prepared.call.function.name;

  switch (decision.kind) {
    case 'UNVERIFIED':
      return { result: decision.result, ran: false };

    case 'DISCOVERED':
      callbacks.onStatus?.(activityForTool(name));
      return { result: decision.result, ran: true };

    case 'REUSE':
      return { result: decision.priorResult, ran: false };

    case 'REJECT':
      return {
        result: notRun(decision.reason, TOOL_ERROR_CODE.EDENIED, { hint: decision.hint, data: { notRunRepeat: true } }),
        ran: false,
      };

    case 'STOP':
      // The decider stops only for a call id that already settled with other arguments. Say so plainly:
      // a backend that reuses ids would show up here, and the saved session should make that visible.
      logger.debug('call id reused for a different call — the turn stops', {
        callId: prepared.call.id,
        name,
        earlier: turnState.toolCalls.find((c) => c.callId === prepared.call.id)?.name,
      });
      turnState.stopReason = decision.reason;
      return { result: fail(decision.reason, { code: TOOL_ERROR_CODE.ESKIPPED }), ran: false };

    case 'EXECUTE': {
      if (!batch.toolsEnabled || !batch.toolsAllowed) {
        return { result: notRun('Tools disabled for this turn', TOOL_ERROR_CODE.EDENIED), ran: false };
      }
      if (!prepared.prep.ok) return { result: prepared.prep.result, ran: false };
      callbacks.onStatus?.(activityForTool(name));
      callbacks.onToolStart?.(name, prepared.call.function.arguments);
      return { result: await runTool(prepared, batch), ran: true };
    }
  }
}

/** Calls that keep finding the same thing are a loop the exact-args guard cannot see; say so in the result.
 *  Only while nothing has changed since: the same findings after an edit are that edit's answer. */
function noteSameFindings(
  turnState: TurnState,
  name: string,
  result: ToolResult,
  ran: boolean,
  world: number,
): { result: ToolResult; resultKey?: string; foundNothingNew?: boolean } {
  const resultKey = ran && result.ok ? defaultRegistry.find(name)?.resultKey?.(result) : undefined;
  if (!resultKey) return { result };
  const sameAs = turnState.toolCalls.find((c) => c.name === name && c.resultKey === resultKey && c.world === world);
  if (!sameAs) return { result, resultKey };
  return {
    resultKey,
    foundNothingNew: true,
    result: {
      ...result,
      modelNote:
        `Nothing new: these are the same results as your earlier call with ${JSON.stringify(sameAs.args)}. ` +
        'Rewording will not find more. Answer from what you already have, or read one result in full.',
    },
  };
}

/** The one place a call settles: the record, what the model reads, what the person sees, and the progress evidence. */
function settleCall(
  batch: ToolCallBatch,
  prepared: PreparedToolCall,
  decision: Decision,
  result: ToolResult,
  ran: boolean,
  resultKey: string | undefined,
  foundNothingNew: boolean,
  outputLimit: number,
): void {
  const { turnState, history, callbacks, progressTracker, workspaceState } = batch;
  const { call, target, targetStamp } = prepared;
  const name = call.function.name;
  const args = call.function.arguments;

  const entry: ToolCallRecord = {
    callId: call.id,
    name,
    args,
    result,
    ...(resultKey ? { resultKey } : {}),
    ...(foundNothingNew ? { foundNothingNew } : {}),
    // The decider's verdict: only REUSE and REJECT are repeats.
    isRepeat: decision.kind === 'REUSE' || decision.kind === 'REJECT',
    // Refusing for a missing schema loaded it, so this is not an attempt the model
    // has already made and must not count as one against the retry it is inviting.
    schemaPending: decision.kind === 'UNVERIFIED',
    at: turnState.iteration,
    target,
    targetStamp,
    afterStamp: ran && target ? fileStamp(target) : null,
    world: Number(workspaceState?.mutationCount ?? 0),
  };
  turnState.toolCalls.push(entry);

  recordProgress(progressTracker, entry);
  // A schema handshake prepares the next call; reading it as a stall ended turns right before the real work.
  if (decision.kind === 'UNVERIFIED' || decision.kind === 'DISCOVERED') progressTracker.recordBookkeeping();

  entry.rendered = recordExchange(history, call, result, outputLimit);

  // Discovery is plumbing: the model sees it, the user does not. A reused result was already shown.
  if (decision.kind !== 'REUSE' && !entry.schemaPending && decision.kind !== 'DISCOVERED') {
    callbacks.onToolResult?.(name, args, result);
  }
  if (ran) callbacks.onStepComplete?.({ name, args, result });
}

/**
 * One pass over a reply's calls.
 *
 * Each call is answered exactly once. A call already handled during this turn is never executed
 * again: decideToolExecution() owns that decision.
 */
export async function processToolCalls(calls: ToolCall[], batch: ToolCallBatch): Promise<void> {
  const { turnState, workspaceState, discovery } = batch;
  const outputLimit = Number(agentConfig().maxToolOutput) || DEFAULT_TOOL_OUTPUT_CHARS;

  try {
    for (const raw of calls) {
      const prepared = prepareToolCall(raw);
      const { call, target, targetStamp } = prepared;
      const name = call.function.name;
      const world = Number(workspaceState?.mutationCount ?? 0);

      const decision: Decision =
        (discovery ? decideDiscovery(raw, discovery.resolver, discovery.onWire) : null) ??
        decideToolExecution(call, turnState, { ...(workspaceState || {}), targetStamp });

      logger.debug('tool call decided', {
        iteration: turnState.iteration,
        name,
        args: stableArgs(call.function.arguments),
        decision: decision.kind,
        why: explainDecision(decision, world, target),
        world,
        ...(target ? { target, targetStamp } : {}),
        calls: turnState.toolCalls.length,
      });

      const outcome = await resultForDecision(decision, prepared, batch);
      const { result, resultKey, foundNothingNew } = noteSameFindings(
        turnState,
        name,
        outcome.result,
        outcome.ran,
        Number(workspaceState?.mutationCount ?? 0),
      );
      settleCall(batch, prepared, decision, result, outcome.ran, resultKey, Boolean(foundNothingNew), outputLimit);
    }
  } catch (err) {
    if (!isCancel(err)) throw err;
    turnState.stopReason = STOP_REASONS.CANCELLED;
  }
}
