import { STOP_REASONS, RATE_SAMPLE_MIN_TOKENS, AGENT_STATUS } from '../../protocol';
import type { TurnResult } from '../../protocol';
import type { ModelGateway } from '../../model/gateway';
import { isContextLengthError, type GatewayCallResult } from '../../model/gateway';
import type { ContextStore } from '../../context/contracts';
import type { Message, ToolResult, ToolSchema } from '../../types';
import { compactForRecovery } from '../../context/builder';
import type { ToolProfile } from '../../context/tool-surface';
import { type ToolExecutor } from '../../tool/execution/executor';
import { defaultRegistry } from '../../tool/execution/registry';
import { ToolResolver } from '../../tool/execution/tool-resolver';
import { loadToolsSchema } from '../../tool/core/load-tools.tool';
import { createTurnState, type TurnState } from './turn-state';
import { normalizeToolCall } from '../../core/ids';
import { recordModelCall, type ModelCallRecord } from '../../core/telemetry';
import { logger } from '../../core/logger';
import { estimateTokens } from '../../context/tokens';
import type { ApproveFn } from '../../tool/policy/permission-policy';
import { clearDenials } from '../../tool/policy/permission-policy';
import { namesOnWire } from './tool-discovery';
import { ProgressTracker } from './progress-tracker';
import { processToolCalls } from './tool-calls';
import { summarizeRound } from './round-guards';
import { closingAnswer } from './closing-answer';
import { createContextRecovery } from './context-recovery';

export interface TurnCallbacks {
  onDelta?: (chunk: string, full: string) => void;
  onReasoning?: (chunk: string, full: string) => void;
  onStatus?: (status: string) => void;
  onToolStart?: (
    name: string,
    args: Record<string, unknown>,
  ) => void;
  onToolResult?: (
    name: string,
    args: Record<string, unknown>,
    result: ToolResult,
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

export interface RunTurnParams {
  provider?: any;
  model: string;
  history: ContextStore;
  systemMessages?: Message[];
  toolsEnabled?: boolean;
  toolsAllowed?: boolean;
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
}

function buildResult(
  state: TurnState,
  telemetry: ModelCallRecord[],
): TurnResult & { answer?: string } {
  return {
    content: state.answer ?? '',
    answer: state.answer,
    toolResults: state.toolCalls
      .filter((c) => !c.isRepeat)
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

export async function runTurn(
  params: RunTurnParams,
): Promise<TurnResult> {
  const {
    provider,
    model,
    history,
    toolsEnabled = true,
    toolsAllowed = true,
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
    toolsAllowed &&
    native === false;

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

  const schema = await import(
    '../../context/tool-surface.ts'
  );

  // On-demand discovery: the request carries the index, the always-tools and whatever the conversation has loaded.
  const discoverable = new Set(
    schema
      .selectToolDefs({
        core: toolProfile.core,
        readOnly,
      })
      .map((def) => def.name),
  );

  const resolver = new ToolResolver({
    registry: defaultRegistry,
    compact: toolProfile.compact,
    always: schema.selectAlwaysToolDefs({
      core: toolProfile.core,
      readOnly,
      always: toolProfile.always,
    }).map((def) => def.name),
    selectable: (def) =>
      discoverable.has(def.name),
  });

  // A tool the conversation already called has been seen, even in a resumed session; the profile still decides.
  resolver.loadAll(
    history.messages.flatMap((m) => (m.tool_calls ?? []).map((c) => String(c.function?.name ?? ''))),
  );

  // load_tools only goes out while something is left to discover.
  const toolsOnWire = (): ToolSchema[] => [
    ...(resolver.discoverableIndex().entries.length > 0 ? [loadToolsSchema(resolver.describe())] : []),
    ...resolver.schemas(),
  ];

  let tools =
    toolsEnabled &&
    toolsAllowed &&
    native
      ? toolsOnWire()
      : [];

  const turnState =
    createTurnState(maxIterations);

  clearDenials(
    workspaceState?.permissions,
  );

  let thinkingOff = false;

  const progressTracker =
    new ProgressTracker();

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
    meta: { model: gateway.model, provider: gateway.provider?.id },
    turnState,
    compactor,
    onStatus: callbacks.onStatus,
  });

  const world = (): number => Number(workspaceState?.mutationCount ?? 0);

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
      previousRound:
        turnState.iteration > 1 && logger.enabled('debug')
          ? summarizeRound(turnState, turnState.iteration - 1)
          : null,
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

    const reply = {
      content: called.result.content ?? '',
      toolCalls: (called.result.toolCalls ?? []).map(normalizeToolCall),
      finishReason: called.result.finishReason,
    };

    if (reply.toolCalls.length === 0) {
      // Only a reply that answers in text is the turn's answer; text said alongside tool calls is narration.
      if (reply.content.trim()) turnState.answer = reply.content;
      // Cut off at the length limit, with or without text so far: the answer can be picked up where it stopped.
      turnState.stopReason =
        reply.finishReason === 'length'
          ? STOP_REASONS.OUTPUT_TRUNCATED
          : STOP_REASONS.COMPLETE;
      break;
    }

    const worldBefore = world();

    progressTracker.beginRound();

    await processToolCalls(reply.toolCalls, {
      turnState,
      history,
      callbacks,
      toolRunner,
      progressTracker,
      workspaceState,
      toolsEnabled,
      toolsAllowed,
      discovery: tools.length > 0 ? { resolver, onWire: namesOnWire(tools) } : undefined,
      signal,
      approve,
    });

    if (signal?.aborted) {
      turnState.stopReason = STOP_REASONS.CANCELLED;
      break;
    }

    const round = summarizeRound(turnState, turnState.iteration);
    const worldAfter = world();

    /*
     * repeatsEarlier and madeProgress are different concepts.
     * The round reproduced earlier output; the round produced
     * new work. A round that executed nothing and moved no
     * state is a fixed point even when it looks new, because
     * reused results carry a fresh notice.
     */
    const madeProgress = round.executed > 0 || worldAfter !== worldBefore;

    logger.debug('round finished', {
      iteration: turnState.iteration,
      requested: reply.toolCalls.length,
      ...round,
      worldBefore,
      worldAfter,
      madeProgress,
      stop: turnState.stopReason ?? null,
    });

    /*
     * ProgressTracker reports; the turn loop owns continuation
     * and termination. Deciding before the guards keeps the
     * per-round state transition visible, including the final
     * one.
     */
    const progressDecision = progressTracker.decide();

    logger.debug('progress', {
      iteration: turnState.iteration,
      action: progressDecision.action,
      reason: progressDecision.reason,
      phase: progressDecision.phase,
      madeProgress: progressDecision.madeProgress,
      evidence: progressDecision.evidence,
    });

    const isReusedOnlyRound = round.reused > 0 && round.reusedAgain === round.reused && !madeProgress;
    const foundNothingNewAgain = round.nothingNew > 0 && round.nothingNewAgain === round.nothingNew && !madeProgress;
    const shouldStop =
      progressDecision.action === 'STOP' ||
      round.refusedOnly ||
      round.repeatsEarlier ||
      isReusedOnlyRound ||
      foundNothingNewAgain;
    if (shouldStop) turnState.stopReason ??= STOP_REASONS.GUARD_STUCK;

    // The last step went on tool calls: the turn ends here, and like a stuck one it owes an account of the work.
    if (!turnState.stopReason && turnState.iteration >= turnState.maxIterations) {
      turnState.stopReason = STOP_REASONS.MAX_ITERATIONS;
    }

    // A turn stopped mid-work ends with the model's own account, however the stop was reached: a guard above, the
    // decider mid-round, or the step limit. Only a text reply sets the answer, and that ends the loop before here,
    // so the closing summary is the answer.
    if (turnState.stopReason === STOP_REASONS.GUARD_STUCK || turnState.stopReason === STOP_REASONS.MAX_ITERATIONS) {
      turnState.answer = await closingAnswer(gateway, {
        history,
        systemMessages,
        workspaceState,
        toolProfile,
        config,
        capacityTokens: recovery.capacityTokens,
        signal,
        callbacks,
      });
    }

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
