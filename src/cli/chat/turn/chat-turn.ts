import { suppressThinking, recordGenerationRate, recordReasoningLeak } from '../../../agent/workspace/thinking';
import { createPromptFn, createApproveFn } from './approval-service';
import { createAskFn } from './prompt-service';
import type { ChatTurnContext, TurnOptions, TurnResult } from './context';
import type { ToolResult } from '../../../types';

const THINKING_OFF_NOTE = 'Thinking switched off — it was using up the whole reply. /think on turns it back on.';

export async function runChatTurn(host: ChatTurnContext, input: string, opts: TurnOptions): Promise<TurnResult> {
  const { render, workspace, agentState } = host;
  const signal = opts.signal;

  const promptFn = createPromptFn(host, signal);
  const approve = createApproveFn(host, promptFn);
  const ask = createAskFn(host, signal);

  return host.runtime.execute({
    provider: host.session.provider,
    model: host.session.model,
    workspace,
    history: host.history,
    input,
    toolsEnabled: host.toolsEnabled,
    includeAutoContext: true,
    signal,
    planMode: opts.planMode,
    reviewMode: opts.reviewMode,
    askMode: opts.askMode,
    continuing: opts.continuing,
    onModeSwitch: opts.onModeSwitch,
    agentState,
    approve,
    ask,
    onDelta: render.onDelta,
    onReasoning: render.onReasoning,
    onStatus: render.onStatus,
    onNote: render.note,
    onCommandOutput: render.onCommandOutput,
    onTelemetry: render.onTelemetry,
    onToolStart: (name: string, args: Record<string, unknown>, origin?: string) => render.onToolStart(name, args, undefined, origin),
    onMentions: render.onMentions,
    onThinkingSuppressed: () => {
      if (suppressThinking(workspace)) render.note(THINKING_OFF_NOTE, 'dim');
    },
    onGenerationRate: (rate: number) => {
      if (recordGenerationRate(workspace, rate) && !workspace.thinkingEnabled) render.note(THINKING_OFF_NOTE, 'dim');
    },
    onReasoningLeak: () => recordReasoningLeak(workspace),
    onToolResult: (name: string, args: Record<string, unknown>, result: ToolResult, origin?: string) => {
      render.onToolResult(name, args, result, origin);
      opts.onToolResult?.(name, args, result, origin);
    },
    onStepComplete: opts.onStepComplete,
    onTaskStart: opts.onTaskStart,
  });
}
