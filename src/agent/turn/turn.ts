import { STOP_REASONS, RATE_SAMPLE_MIN_TOKENS, AGENT_STATUS, TOOL_NAME } from '../../protocol';
import type { TurnResult } from '../../protocol';
import type { ModelGateway } from '../../model/gateway';
import { isContextLengthError, type GatewayCallResult } from '../../model/gateway';
import type { ContextStore } from '../../context/contracts';
import type { Message, ToolResult, ToolSchema } from '../../types';
import { compactForRecovery } from '../../context/builder';
import { selectToolDefs, type ToolProfile } from '../../context/tool-surface';
import { type ToolExecutor } from '../../tool/execution/executor';
import { toToolSchema } from '../../tool/execution/tool-wire';
import { createTurnState, sameCallStreak, SAME_CALL_LIMIT, type TurnState } from './turn-state';
import { normalizeToolCall } from '../../core/ids';
import { recordModelCall, type ModelCallRecord } from '../../core/telemetry';
import { logger } from '../../core/logger';
import { estimateTokens } from '../../context/tokens';
import { changeMark, changedSince, passedNow } from '../../context/workspace-state';
import { todoLines } from '../todos';
import todoWrite from '../planning/todo-write.tool';
import type { ApproveFn } from '../../tool/policy/permission-policy';
import { clearDenials } from '../../tool/policy/permission-policy';
import { processToolCalls } from './tool-calls';
import { createContextRecovery } from './context-recovery';
import { startsToolCall } from '../response/tool-parser';
import { runAfterEditCheck, runBeforeDoneCheck } from './after-edit';
import { recordExchange } from './tool-calls';
import { createSubagentRunner } from '../subagent/runner';

export interface TurnCallbacks {
  onDelta?: (chunk: string, full: string) => void;
  onReasoning?: (chunk: string, full: string) => void;
  onStatus?: (status: string) => void;
  /** origin names the subagent a call came from (e.g. "review 1"); absent for the main turn's own calls. */
  onToolStart?: (
    name: string,
    args: Record<string, unknown>,
    origin?: string,
  ) => void;
  onToolResult?: (
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
    origin?: string,
  ) => void;
  onTelemetry?: (record: any) => void;
  onThinkingSuppressed?: () => void;
  onReasoningLeak?: (snippet: string | undefined) => void;
  onGenerationRate?: (tokensPerSec: number) => void;
  onStepComplete?: (entry: {
    name: string;
    args: Record<string, unknown>;
    result: ToolResult,
  }) => void;
  onCommandOutput?: (text: string) => void;
  note?: (text: string, tone?: 'info' | 'warn' | 'error' | 'success' | 'dim') => void;
}

interface RunTurnParams {
  provider?: any;
  model: string;
  history: ContextStore;
  systemMessages?: Message[];
  toolsEnabled?: boolean;
  toolProfile?: ToolProfile;
  config: any;
  cwd?: string;
  state?: any;
  signal?: AbortSignal;
  approve?: ApproveFn;
  ask?: any;
  gateway?: ModelGateway;
  toolRunner?: ToolExecutor;
  callbacks?: TurnCallbacks;
  /** Reactive history compaction for a context-full retry; injectable for tests. */
  compactor?: typeof compactForRecovery;
  /** 1 for a subagent's turn, which can never start one of its own. */
  subagentDepth?: number;
}

function buildResult(
  state: TurnState,
  telemetry: ModelCallRecord[],
): TurnResult & { answer?: string } {
  return {
    content: state.answer ?? '',
    answer: state.answer,
    toolResults: state.toolCalls
      .map((c) => ({
        name: c.name,
        args: c.args,
        result: c.result,
      })),
    iterations: state.iteration,
    stopReason:
      state.stopReason ?? STOP_REASONS.MAX_ITERATIONS,
    telemetry,
  };
}

/** Reasoning used the whole reply budget: the model was cut off before it wrote any text or asked for any tool. */
function reasoningFilledReply(result: GatewayCallResult['result']): boolean {
  return (
    result.finishReason === 'length' &&
    Boolean(result.reasoning) &&
    !String(result.content ?? '').trim() &&
    (result.toolCalls ?? []).length === 0
  );
}

/** Records one model call and reports its telemetry and generation rate. */
function recordTelemetry(
  called: GatewayCallResult,
  model: string,
  telemetry: ModelCallRecord[],
  callbacks: TurnCallbacks,
): void {
  const record = recordModelCall(called.result, {
    model,
    attempt: called.attempt,
    retries: called.retries,
    startedAt: called.startedAt,
    reasoningTokens: estimateTokens(String(called.result.reasoning ?? '')),
  });

  telemetry.push(record);
  callbacks.onTelemetry?.(record);

  if (record.genTokensPerSec && (record.completionTokens ?? 0) >= RATE_SAMPLE_MIN_TOKENS) {
    callbacks.onGenerationRate?.(record.genTokensPerSec);
  }
}

/** The status while agent.beforeDone runs: the answer is on screen, the turn is not over. */
const CHECKING_STATUS = 'Checking the work before finishing';

/** What the person reads once agent.beforeDone has run, under the answer it checked. */
function doneCheckNote(runs: Array<{ label: string; passed: boolean; unfinished: boolean }>, failed: boolean): [string, 'warn' | 'success'] | null {
  const names = (list: typeof runs) => list.map((r) => `\`${r.label}\``).join(', ');
  if (failed) return [`Not done yet: ${names(runs.filter((r) => !r.passed && !r.unfinished))} failed after that answer, so the agent keeps working on what it reports.`, 'warn'];
  const unfinished = runs.filter((r) => r.unfinished);
  if (unfinished.length) return [`Checked before finishing: ${names(unfinished)} could not finish, so that part of the answer is unchecked.`, 'warn'];
  return runs.length ? [`Checked before finishing: ${names(runs)} passed.`, 'success'] : null;
}

/**
 * What the model reads when it answers over tasks it left open after changing files. A task is completed only on
 * evidence, and only the model can give it for work no command proves, so the list goes back to it once.
 */
function openTasksNote(open: number, passed: string[]): string {
  return `Your answer leaves ${open} task${open === 1 ? '' : 's'} open (listed below). Settle the list before you finish, with todo_write update: ` +
    'mark each task you did completed with its evidence (what showed it works' +
    (passed.length ? `; these checks passed when you answered: ${passed.map((p) => `\`${p}\``).join(', ')}` : '') +
    '), and remove the ones you did not do or no longer need. Then answer again.';
}

/** What the model reads with a check of agent.beforeDone that failed. */
const BEFORE_DONE_FAILED =
  'ocode ran this check (agent.beforeDone) when you answered, and it failed: the work is not done. Fix what it reports, then answer again.';

export async function runTurn(
  params: RunTurnParams,
): Promise<TurnResult> {
  const {
    provider,
    model,
    history,
    toolsEnabled = true,
    toolProfile = {},
    config = {},
    cwd = process.cwd(),
    state: workspaceState = {},
    signal,
    approve,
    ask,
    gateway: providedGateway,
    toolRunner: providedRunner,
    callbacks = {},
    compactor = compactForRecovery,
  } = params;

  // Context recovery adds its completed-actions note to this list in place; callers read it back.
  const systemMessages = params.systemMessages ?? [];

  const maxIterations =
    Number(config.maxIterations) || 25;

  const native =
    toolProfile.native !== false;

  const readOnly =
    Boolean(toolProfile.readOnly);

  const toolsInPrompt =
    toolsEnabled &&
    !native;

  const gateway =
    providedGateway ??
    (await import(
      '../../model/gateway.ts'
    )).createModelGateway({
      provider,
      model,
      config,
      tunnel: Boolean(
        workspaceState?.tunnel,
      ),
    });

  const toolRunner =
    providedRunner ??
    (await import(
      '../../tool/execution/executor.ts'
    )).createExecutor({
      root: cwd,
      state: workspaceState,
      timeoutMs:
        config.toolTimeoutMs,
      approve,
      ask,
      onCommandOutput:
        callbacks.onCommandOutput,
    });

  // A turn that may change things may hand tasks to subagents unless they are switched off; a subagent's turn never can,
  // so they go one level deep. The delegate tool is offered only where this function exists.
  const delegate =
    toolsEnabled && !readOnly && config.subagents !== false && !params.subagentDepth
      ? createSubagentRunner(
          { provider, model, systemMessages, budgetTokens: history.budgetTokens, toolProfile, config, cwd, state: workspaceState, approve, gateway, toolRunner, callbacks },
          runTurn,
        )
      : undefined;
  const surface: ToolProfile = {
    core: toolProfile.core,
    readOnly,
    include: toolProfile.include,
    exclude: [...(toolProfile.exclude ?? []), ...(delegate ? [] : [TOOL_NAME.DELEGATE_TASK])],
  };

  // Every tool the profile allows goes out in full. Re-read each step: an MCP server named mid-turn adds its tools.
  const toolsOnWire = (): ToolSchema[] => selectToolDefs(surface).map((def) => toToolSchema(def, { compact: toolProfile.compact }));

  let tools =
    toolsEnabled &&
    native
      ? toolsOnWire()
      : [];

  const turnState =
    createTurnState(maxIterations);

  clearDenials(
    workspaceState?.permissions,
  );

  let thinkingOff = false;

  const telemetry: ModelCallRecord[] = [];

  const recovery = createContextRecovery({
    history,
    systemMessages,
    tools: () => tools,
    config,
    workspaceState,
    textMode: !native,
    core: toolProfile.core,
    readOnly,
    include: surface.include,
    exclude: surface.exclude,
    meta: { model: gateway.model, provider: gateway.provider?.id },
    turnState,
    compactor,
    onStatus: callbacks.onStatus,
  });

  const world = (): number => Number(workspaceState?.mutationCount ?? 0);

  // agent.beforeDone runs when the model answers, on the files changed since it last ran (from the turn's start).
  // A subagent's work is checked with the rest of the turn, when the agent that answers the person says it is done.
  const beforeDone = typeof config.beforeDone === 'string' && !params.subagentDepth ? config.beforeDone.trim() : '';
  let doneMark = changeMark(workspaceState);
  // The task list this turn started with: one the turn wrote or changed is this turn's to settle before it answers.
  const listAtStart = workspaceState?.todos;
  const turnMark = changeMark(workspaceState);
  let listSettleAsked = false;
  let passedChecks: string[] = [];
  // How long a configured check may run; unset, each kind keeps its own default.
  const checkTimeoutMs = Number(config.checkTimeoutMs) > 0 ? Number(config.checkTimeoutMs) : undefined;

  while (
    turnState.iteration <
    turnState.maxIterations
  ) {
    if (signal?.aborted) {
      turnState.stopReason =
        STOP_REASONS.CANCELLED;
      break;
    }

    turnState.iteration += 1;

    logger.debug(`step ${turnState.iteration} of ${turnState.maxIterations}`);

    let request = await recovery.nextRequest();

    logger.debug('asking the model', {
      iteration: turnState.iteration,
      maxIterations: turnState.maxIterations,
      tools: tools.length,
      messages: request.messages.length,
      world: world(),
    });

    /**
     * The ask-the-model step. Every recovery here re-asks the same request as the same step, so none of it
     * replays completed work or uses up a step: a context-full error compacts history and asks again, and
     * a reply whose reasoning used the whole budget (no text, no calls) is asked again without reasoning,
     * once per turn.
     */
    const streamReply = async (): Promise<GatewayCallResult> => {
      for (;;) {
        // Set before every call, including the retry after making room, so "Making room" never outlives the compaction.
        callbacks.onStatus?.(AGENT_STATUS.THINKING);
        let called: GatewayCallResult;
        try {
          called = await gateway.stream({
            messages: request.messages,
            tools,
            signal,
            think: thinkingOff ? false : undefined,
            onDelta: callbacks.onDelta,
            onReasoning: callbacks.onReasoning,
            onStatus: callbacks.onStatus,
            toolsInPrompt,
          });
        } catch (err) {
          // The reply never landed, so nothing was recorded: retrying the same iteration
          // re-asks cleanly instead of replaying work.
          if (signal?.aborted || !isContextLengthError(err)) throw err;
          request = await recovery.afterContextFull();
          continue;
        }

        recordTelemetry(called, gateway.model, telemetry, callbacks);
        if (called.result.reasoning?.trim()) callbacks.onReasoningLeak?.(called.result.reasoning);

        if (thinkingOff || !reasoningFilledReply(called.result)) return called;
        thinkingOff = true;
        callbacks.onThinkingSuppressed?.();
        logger.debug('reasoning used the whole reply budget — asking again without it');
      }
    };

    const called = await streamReply();
    // A provider can end its stream with whatever arrived before the stop instead of throwing: that is not the model's answer.
    if (signal?.aborted) {
      turnState.stopReason = STOP_REASONS.CANCELLED;
      break;
    }

    const reply = {
      content: called.result.content ?? '',
      toolCalls: (called.result.toolCalls ?? []).map(normalizeToolCall),
      finishReason: called.result.finishReason,
    };

    if (reply.toolCalls.length === 0) {
      // Only a reply that answers in text is the turn's answer; text said alongside tool calls is narration. A reply cut
      // off while it was still writing a tool call out as text is a call that never arrived: kept as the answer, it
      // went into the conversation and the model built on its own half-call.
      const halfCall = reply.finishReason === 'length' && startsToolCall(reply.content);
      // The person's own check of "done", once per set of changes: a failure is recorded as the call ocode made, with
      // the model's answer as what it said before it, and the turn goes on so the model can fix what it reports. With
      // nothing changed since the last run there is nothing new to check, so a model that cannot fix it still answers.
      const unchecked = beforeDone && !readOnly && toolsEnabled && !workspaceState?.planHeld && reply.finishReason !== 'length'
        ? changedSince(workspaceState, doneMark)
        : [];
      if (unchecked.length > 0 && turnState.iteration < turnState.maxIterations) {
        doneMark = changeMark(workspaceState);
        callbacks.onStatus?.(CHECKING_STATUS);
        const runs = await runBeforeDoneCheck({ command: beforeDone, timeoutMs: checkTimeoutMs, memory: workspaceState, root: workspaceState?.root ?? cwd, changed: unchecked, toolRunner, callbacks, signal });
        if (signal?.aborted) {
          turnState.stopReason = STOP_REASONS.CANCELLED;
          break;
        }
        // Only a check that ran to the end and failed says the work is not done; one that ran out of time says nothing.
        const failed = runs.filter((r) => !r.passed && !r.unfinished);
        passedChecks = runs.filter((r) => r.passed).map((r) => r.label);
        // The answer was on screen before the checks ran: say what they found, so it never reads as checked when it is not.
        const told = doneCheckNote(runs, failed.length > 0);
        if (told) callbacks.note?.(...told);
        if (failed.length > 0) {
          const limit = Number(config.maxToolOutput) || 8000;
          failed.forEach((run, k) => {
            const call = { id: '', type: 'function' as const, function: { name: run.tool, arguments: run.args } };
            const result = { ...run.result, modelNote: [run.result.modelNote, BEFORE_DONE_FAILED].filter(Boolean).join('\n') };
            recordExchange(history, call, result, limit, k === 0 ? reply.content : '');
          });
          continue;
        }
      }
      // Work done this turn, and the list this turn made still has open tasks: once, the list goes back to the model to
      // settle. With nothing changed (a plan offered, a question answered), the answer stands as it is.
      const open = ((workspaceState?.todos ?? []) as import('../todos').TodoItem[]).filter((todo) => todo.status !== 'completed');
      if (
        !listSettleAsked && open.length > 0 && workspaceState?.todos !== listAtStart && !params.subagentDepth && !readOnly && toolsEnabled &&
        !workspaceState?.planHeld && reply.finishReason !== 'length' && changedSince(workspaceState, turnMark).length > 0 &&
        turnState.iteration < turnState.maxIterations
      ) {
        listSettleAsked = true;
        callbacks.note?.(`${open.length} task${open.length === 1 ? ' is' : 's are'} still open after that answer, so the agent settles its task list.`, 'warn');
        const call = { id: '', type: 'function' as const, function: { name: todoWrite.name, arguments: { update: [] } } };
        const listed = todoLines(workspaceState!.todos, (command) => passedNow(workspaceState, command)).join('\n');
        recordExchange(history, call, { ok: true, kind: 'status', display: listed, modelNote: openTasksNote(open.length, passedChecks) }, Number(config.maxToolOutput) || 8000, reply.content);
        continue;
      }
      if (reply.content.trim() && !halfCall) turnState.answer = reply.content;
      // Cut off at the length limit, with or without text so far: the answer can be picked up where it stopped.
      turnState.stopReason =
        reply.finishReason === 'length'
          ? STOP_REASONS.OUTPUT_TRUNCATED
          : STOP_REASONS.COMPLETE;
      break;
    }

    const changesBefore = changeMark(workspaceState);

    await processToolCalls(reply.toolCalls, {
      turnState,
      history,
      callbacks,
      toolRunner,
      workspaceState,
      toolsEnabled,
      signal,
      approve,
      delegate,
      narration: reply.content,
      reasoning: called.result.reasoning,
    });

    if (signal?.aborted) {
      turnState.stopReason = STOP_REASONS.CANCELLED;
      break;
    }

    // agent.afterEdit runs once after a step that changed files.
    const afterEdit = typeof config.afterEdit === 'string' ? config.afterEdit.trim() : '';
    const changed = changedSince(workspaceState, changesBefore);
    // Not while a plan shown this turn is held: nothing may run, and a refused check is no failed one.
    if (afterEdit && !readOnly && toolsEnabled && changed.length > 0 && !workspaceState?.planHeld) {
      await runAfterEditCheck({ command: afterEdit, timeoutMs: checkTimeoutMs, memory: workspaceState, root: workspaceState?.root ?? cwd, changed, history, toolRunner, callbacks, signal });
    }

    // The one loop stop besides the step limit: the same call, nothing else between, too many times in a row.
    const streak = sameCallStreak(turnState);
    logger.debug('round finished', { iteration: turnState.iteration, requested: reply.toolCalls.length, sameCallStreak: streak, stop: turnState.stopReason ?? null });
    if (streak >= SAME_CALL_LIMIT) turnState.stopReason ??= STOP_REASONS.GUARD_STUCK;

    // The last step went on tool calls: the turn ends here.
    if (!turnState.stopReason && turnState.iteration >= turnState.maxIterations) {
      turnState.stopReason = STOP_REASONS.MAX_ITERATIONS;
    }

    // A turn stopped mid-work ends on ocode's own report of what ran and why it stopped. No extra request asks the
    // model for a summary: it re-sent the whole conversation, and models often answered it with nothing.

    if (turnState.stopReason) {
      break;
    }

    if (tools.length > 0) {
      tools = toolsOnWire();
    }
  }

  return buildResult(
    turnState,
    telemetry,
  );
}
