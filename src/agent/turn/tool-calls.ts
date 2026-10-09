// One pass over a reply's tool calls: prepare, run, then record each call's real result exactly once.

import fs from 'node:fs';
import path from 'node:path';
import { STOP_REASONS, TOOL_ERROR_CODE, isGateRefusal } from '../../protocol';
import type { ContextStore } from '../../context/contracts';
import type { ToolCall, ToolResult } from '../../types';
import { type ToolExecutor } from '../../tool/execution/executor';
import { prepareCall } from '../../tool/execution/prepare';
import { defaultRegistry } from '../../tool/execution/registry';
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
import { skillNote } from '../../skills/notes';
import { SAME_CALL_LIMIT, signatureOf, unchangedRepeats, type TurnState, type ToolCallRecord } from './turn-state';
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
  signal?: AbortSignal;
  approve?: ApproveFn;
  /** Set in a turn that may start subagents; the delegate tool reads it from its context. */
  delegate?: import('../subagent/runner.ts').DelegateFn;
  /** What the reply said alongside its calls: the person saw it, so the model keeps it too. */
  narration?: string;
  /** What the model reasoned before the calls; it goes back with them, so its next step starts from the same plan. */
  reasoning?: string;
}

/**
 * Run it; answer it with the result an identical read already got, when nothing has changed since; or stop the turn:
 * for a call already made too often with nothing changed, or a provider that reuses a call id for a different call
 * (which would otherwise get two results under one id).
 */
type Decision =
  | { kind: 'EXECUTE' }
  | { kind: 'REUSE'; result: ToolResult }
  | { kind: 'STOP'; reason: typeof STOP_REASONS.GUARD_STUCK };

/** A call with its name resolved and its arguments prepared. */
interface PreparedToolCall {
  call: ToolCall;
  prep: ReturnType<typeof prepareCall>;
}

/** Adds the assistant/tool pair to history and returns the exact text the model now sees for it: the rendered result, cleaned and held to the shared output budget. */
export function recordExchange(history: ContextStore, call: ToolCall, result: ToolResult, limit: number, narration = '', reasoning = ''): string {
  const settled: ToolCall = { ...call, id: call.id || newId() };
  history.addAssistant(narration, [settled], { reasoning });
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

/**
 * Every call runs, except the tool-loading handshake, a call id already answered for another call, and a read-only call
 * identical to one that already succeeded with nothing changed since: that one gets the earlier result back.
 */
function decide(call: ToolCall, turnState: TurnState, batch: ToolCallBatch): Decision {
  const settled = turnState.toolCalls.find((c) => c.callId === call.id);
  if (settled && signatureOf(settled) !== signatureOf({ name: call.function.name, args: call.function.arguments } as ToolCallRecord)) {
    return { kind: 'STOP', reason: STOP_REASONS.GUARD_STUCK };
  }
  // The same call, run this many times with nothing changed since, would only say the same again: a loop, even when
  // other calls come in between. A tool whose answer changes on its own (a running job's status) is exempt.
  const signature = signatureOf({ name: call.function.name, args: call.function.arguments } as ToolCallRecord);
  if (defaultRegistry.find(call.function.name)?.changesOnItsOwn !== true && unchangedRepeats(turnState, signature, worldOf(batch.workspaceState)) >= SAME_CALL_LIMIT) {
    return { kind: 'STOP', reason: STOP_REASONS.GUARD_STUCK };
  }
  const reused = earlierRead(call, turnState, batch.workspaceState);
  if (reused) return { kind: 'REUSE', result: reused };
  return { kind: 'EXECUTE' };
}

/**
 * The result of the same read-only call made earlier in this turn, when it succeeded and nothing since could have
 * changed what it read: no recorded workspace change, and no call between that does more than read.
 */
function earlierRead(call: ToolCall, turnState: TurnState, workspaceState: any): ToolResult | null {
  const name = call.function.name;
  if (defaultRegistry.find(name)?.readOnly !== true) return null;
  const signature = signatureOf({ name, args: call.function.arguments } as ToolCallRecord);
  const calls = turnState.toolCalls;
  for (let i = calls.length - 1; i >= 0; i--) {
    const earlier = calls[i];
    if (signatureOf(earlier) === signature) {
      // Only a read whose every path is a file can be shown unchanged: a folder's time misses edits inside it, and a
      // call with no path has nothing to check.
      const unchanged = earlier.world === worldOf(workspaceState) && earlier.stamps !== undefined && sameStamps(earlier.stamps, pathStamps(name, call.function.arguments, workspaceState));
      return earlier.result?.ok && unchanged ? earlier.result : null;
    }
    const def = defaultRegistry.find(earlier.name);
    if (def?.readOnly !== true && def?.tracksTasks !== true) return null;
  }
  return null;
}

/**
 * Where the workspace is: its recorded file changes, and its mutation count, which also moves for every command or
 * script that may have changed something without naming a file. Equal means nothing has happened in between.
 */
function worldOf(workspaceState: any): number {
  return Number(workspaceState?.changeSeq ?? 0) + Number(workspaceState?.mutationCount ?? 0);
}

/** The workspace-relative paths a call names in its path arguments (schema properties marked `pathArg`). */
function pathArgs(name: string, args: Record<string, unknown>, root: string): string[] {
  const props = (defaultRegistry.find(name)?.parameters as any)?.properties ?? {};
  return Object.entries(props)
    .filter(([key, schema]) => (schema as any)?.pathArg && typeof args?.[key] === 'string' && String(args[key]).trim())
    .map(([key]) => path.relative(root, path.resolve(root, String(args[key]))));
}

/**
 * The modification time of every path argument of a read-only call; -1 for a path that is not there. A file the
 * person edited in their own editor changes its time without the session recording it.
 * Undefined when there is no path, or one is a folder, whose time does not change when a file inside it does.
 */
function pathStamps(name: string, args: Record<string, unknown>, workspaceState: any): Record<string, number> | undefined {
  if (defaultRegistry.find(name)?.readOnly !== true) return undefined;
  const root = String(workspaceState?.root ?? process.cwd());
  const stamps: Record<string, number> = {};
  for (const rel of pathArgs(name, args, root)) {
    const abs = path.resolve(root, rel);
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return undefined;
      stamps[abs] = stat.mtimeMs;
    } catch {
      stamps[abs] = -1;
    }
  }
  return Object.keys(stamps).length ? stamps : undefined;
}

/** A result that worked on a file a skill covers carries a pointer to that skill, for the model alone. */
function withSkillNote(result: ToolResult, name: string, args: Record<string, unknown>, batch: ToolCallBatch): ToolResult {
  if (!result.ok) return result;
  const root = String(batch.workspaceState?.root ?? process.cwd());
  const note = skillNote(pathArgs(name, args, root), (batch.turnState.skillsNoted ??= new Set()));
  return note ? { ...result, modelNote: [result.modelNote, note].filter(Boolean).join('\n') } : result;
}

function sameStamps(before: Record<string, number> | undefined, now: Record<string, number> | undefined): boolean {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(now ?? {})]);
  return [...keys].every((key) => before?.[key] === now?.[key]);
}

const NOT_RUN_AGAIN = 'Not run again: this is the same call as an earlier one in this turn, and nothing has changed since, so this is its result.';

/** The result a decision stands for, and whether a tool actually ran to produce it. */
async function resultForDecision(
  decision: Decision,
  prepared: PreparedToolCall,
  batch: ToolCallBatch,
): Promise<{ result: ToolResult; ran: boolean }> {
  const { callbacks, turnState } = batch;
  const name = prepared.call.function.name;

  switch (decision.kind) {
    case 'REUSE':
      return { result: { ...decision.result, modelNote: [NOT_RUN_AGAIN, decision.result.modelNote].filter(Boolean).join('\n') }, ran: false };

    case 'STOP':
      // A backend that reuses ids, or a call made too often with nothing changed: the saved session should show which.
      logger.debug('the turn stops before this call', {
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
  outcome: { result: ToolResult; ran: boolean },
  outputLimit: number,
  narration = '',
  reasoning = '',
): void {
  const { turnState, history, callbacks } = batch;
  const { call } = prepared;
  const name = call.function.name;
  const args = call.function.arguments;
  const { ran } = outcome;
  const result = withSkillNote(outcome.result, name, args, batch);

  const entry: ToolCallRecord = {
    callId: call.id,
    name,
    args,
    result,
    at: turnState.iteration,
    world: worldOf(batch.workspaceState),
    stamps: pathStamps(name, args, batch.workspaceState),
  };
  turnState.toolCalls.push(entry);


  if (isGateRefusal(result.code) && (result.code === TOOL_ERROR_CODE.EDENIED || result.code === TOOL_ERROR_CODE.EPOLICY)) {
    turnState.stopReason ??= STOP_REASONS.GUARD_STUCK;
  }

  entry.rendered = recordExchange(history, call, result, outputLimit, narration, reasoning);

  callbacks.onToolResult?.(name, args, result);
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
  let reasoning = String(batch.reasoning ?? '');

  // Prepared once, so a call keeps the one id it is given.
  const prepared = calls.map(prepareToolCall);
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
        const decision = decide(g.call, turnState, batch);
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
        settleCall(batch, d.prepared, outcomes[k], outputLimit, narration, reasoning);
        narration = '';
        reasoning = '';
      });
    }
  } catch (err) {
    if (!isCancel(err)) throw err;
    turnState.stopReason = STOP_REASONS.CANCELLED;
  }
}
