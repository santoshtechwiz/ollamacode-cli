// One pass over a reply's tool calls: prepare, run, then record each call's real result exactly once.

import { STOP_REASONS, TOOL_ERROR_CODE, isGateRefusal } from '../../protocol';
import type { ContextStore } from '../../context/contracts';
import type { ToolCall, ToolResult } from '../../types';
import { type ToolExecutor } from '../../tool/execution/executor';
import { prepareCall } from '../../tool/execution/prepare';
import { defaultRegistry } from '../../tool/execution/registry';
import type { ToolResolver } from '../../tool/execution/tool-resolver';
import { fail } from '../../tool/core/tool-result';
import { newId } from '../../core/ids';
import { isCancel } from '../../core/errors';
import { isToolCallBlock, isToolCallLine } from '../response/tool-parser';
import { agentConfig } from '../../core/config';
import { logger } from '../../core/logger';
import type { ApproveFn } from '../../tool/policy/permission-policy';
import { compressToolOutput } from '../../context/result-compression';
import { renderToolResult } from '../router/render';
import { activityForTool } from '../status';
import { decideDiscovery, type DiscoveryDecision } from './tool-discovery';
import { signatureOf, type TurnState, type ToolCallRecord } from './turn-state';
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
  workspaceState: any;
  toolsEnabled: boolean;
  /** Set only when a tool index is on the wire, with the names the model was shown; absent in text mode. */
  discovery?: { resolver: ToolResolver; onWire: ReadonlySet<string> };
  signal?: AbortSignal;
  approve?: ApproveFn;
  /** Set in a turn that may start subagents; the delegate tool reads it from its context. */
  delegate?: import('../subagent/runner.ts').DelegateFn;
  /** What the reply said alongside its calls: the person saw it, so the model keeps it too. */
  narration?: string;
}

/** Run it, or stop the turn: a provider that reuses a call id for a different call would otherwise get two results under one id. */
type Decision = DiscoveryDecision | { kind: 'EXECUTE' } | { kind: 'STOP'; reason: typeof STOP_REASONS.GUARD_STUCK };

/** A call with its name resolved and its arguments prepared. */
interface PreparedToolCall {
  call: ToolCall;
  prep: ReturnType<typeof prepareCall>;
}

/** Adds the assistant/tool pair to history and returns the exact text the model now sees for it: the rendered result, cleaned and held to the shared output budget. */
function recordExchange(history: ContextStore, call: ToolCall, result: ToolResult, limit: number, narration = ''): string {
  const settled: ToolCall = { ...call, id: call.id || newId() };
  history.addAssistant(narration, [settled]);
  const rendered = compressToolOutput(renderToolResult(result, settled.function.name), limit);
  history.addToolResult(settled, rendered);
  return rendered;
}

/** The prose of a reply that also called tools: lines that only spell out a call are the call itself, already recorded. */
function narrationOf(content: string | undefined): string {
  const text = String(content ?? '').trim();
  if (!text || isToolCallBlock(text)) return '';
  return text.split('\n').filter((line) => !isToolCallLine(line)).join('\n').trim();
}

/** Sorted args, so a log line reads the same however the model ordered the keys. */
function stableArgs(args: Record<string, unknown>): string {
  return JSON.stringify(args, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

function prepareToolCall(call: ToolCall): PreparedToolCall {
  const prep = prepareCall(String(call.function?.name ?? ''), (call.function?.arguments ?? {}) as Record<string, unknown>);
  return {
    call: { ...call, id: String(call.id ?? newId()), function: { name: prep.resolved, arguments: prep.args } },
    prep,
  };
}

/** A refusal that never reached the tool. */
function notRun(error: string, code: string): ToolResult {
  return { ok: false, kind: 'text', error, code } as ToolResult;
}

/** Every call runs; the only exceptions are the tool-loading handshake and a call id already answered for another call. */
function decide(call: ToolCall, turnState: TurnState, batch: ToolCallBatch, raw: ToolCall): Decision {
  const discovered = batch.discovery ? decideDiscovery(raw, batch.discovery.resolver, batch.discovery.onWire) : null;
  if (discovered) return discovered;
  const settled = turnState.toolCalls.find((c) => c.callId === call.id);
  if (settled && signatureOf(settled) !== signatureOf({ name: call.function.name, args: call.function.arguments } as ToolCallRecord)) {
    return { kind: 'STOP', reason: STOP_REASONS.GUARD_STUCK };
  }
  return { kind: 'EXECUTE' };
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

    case 'STOP':
      // A backend that reuses ids would show up here, and the saved session should make that visible.
      logger.debug('call id reused for a different call — the turn stops', {
        callId: prepared.call.id,
        name,
        earlier: turnState.toolCalls.find((c) => c.callId === prepared.call.id)?.name,
      });
      turnState.stopReason = decision.reason;
      return { result: fail(decision.reason, { code: TOOL_ERROR_CODE.ESKIPPED }), ran: false };

    case 'EXECUTE': {
      if (!batch.toolsEnabled) {
        return { result: notRun('Tools disabled for this turn', TOOL_ERROR_CODE.EDENIED), ran: false };
      }
      if (!prepared.prep.ok) return { result: prepared.prep.result, ran: false };
      callbacks.onStatus?.(activityForTool(name));
      callbacks.onToolStart?.(name, prepared.call.function.arguments);
      const outcome = await batch.toolRunner.run(name, prepared.call.function.arguments, { signal: batch.signal, approve: batch.approve, delegate: batch.delegate });
      return { result: outcome.result, ran: true };
    }
  }
}

/** The one place a call settles: the record, what the model reads, and what the person sees. */
function settleCall(
  batch: ToolCallBatch,
  prepared: PreparedToolCall,
  decision: Decision,
  { result, ran }: { result: ToolResult; ran: boolean },
  outputLimit: number,
  narration = '',
): void {
  const { turnState, history, callbacks } = batch;
  const { call } = prepared;
  const name = call.function.name;
  const args = call.function.arguments;

  const entry: ToolCallRecord = {
    callId: call.id,
    name,
    args,
    result,
    // Refusing for a missing schema loaded it: the handshake, not an attempt the model made.
    schemaPending: decision.kind === 'UNVERIFIED',
    at: turnState.iteration,
  };
  turnState.toolCalls.push(entry);

  if (isGateRefusal(result.code) && (result.code === TOOL_ERROR_CODE.EDENIED || result.code === TOOL_ERROR_CODE.EPOLICY)) {
    turnState.stopReason ??= STOP_REASONS.GUARD_STUCK;
  }

  entry.rendered = recordExchange(history, call, result, outputLimit, narration);

  // Discovery is plumbing: the model sees it, the person does not.
  if (decision.kind !== 'UNVERIFIED' && decision.kind !== 'DISCOVERED') {
    callbacks.onToolResult?.(name, args, result);
  }
  if (ran) callbacks.onStepComplete?.({ name, args, result });
}

/** A call its tool says may run beside the calls next to it (a read-only subagent). */
function runsAlongside(prepared: PreparedToolCall): boolean {
  if (!prepared.prep.ok) return false;
  return defaultRegistry.find(prepared.call.function.name)?.concurrent?.(prepared.call.function.arguments) === true;
}

/**
 * One pass over a reply's calls: each is run and answered exactly once, with its real result. Consecutive calls whose
 * tool allows it run at the same time; every result is still recorded in the order the model asked, so the
 * conversation reads the same as if they had run one by one.
 */
export async function processToolCalls(calls: ToolCall[], batch: ToolCallBatch): Promise<void> {
  const { turnState } = batch;
  const outputLimit = Number(agentConfig().maxToolOutput) || DEFAULT_TOOL_OUTPUT_CHARS;
  // The reply's own words go with its first call, once; a model that does not see what it said says it again.
  let narration = narrationOf(batch.narration);

  // Prepared once, so a call keeps the one id it is given.
  const prepared = calls.map((raw) => ({ raw, ...prepareToolCall(raw) }));
  try {
    for (let i = 0; i < prepared.length && !turnState.stopReason; ) {
      // The next call, and the ones right after it that may run beside it. A repeated id waits for the call before
      // it to be recorded, so the decision below can see the reuse.
      const group = [prepared[i++]];
      while (
        i < prepared.length &&
        runsAlongside(group[0]) &&
        runsAlongside(prepared[i]) &&
        !group.some((g) => g.call.id === prepared[i].call.id)
      ) group.push(prepared[i++]);

      const decided: Array<{ prepared: PreparedToolCall; decision: Decision }> = [];
      for (const g of group) {
        const decision = decide(g.call, turnState, batch, g.raw);
        logger.debug('tool call', {
          iteration: turnState.iteration,
          name: g.call.function.name,
          args: stableArgs(g.call.function.arguments),
          decision: decision.kind,
        });
        decided.push({ prepared: g, decision });
        if (decision.kind === 'STOP') break;
      }

      const outcomes = await Promise.all(decided.map((d) => resultForDecision(d.decision, d.prepared, batch)));
      decided.forEach((d, k) => {
        settleCall(batch, d.prepared, d.decision, outcomes[k], outputLimit, narration);
        narration = '';
      });
    }
  } catch (err) {
    if (!isCancel(err)) throw err;
    turnState.stopReason = STOP_REASONS.CANCELLED;
  }
}
