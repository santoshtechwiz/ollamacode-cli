import { ROLE, STOP_REASONS } from '../../protocol';
import { REVIEW_MODE, ASK_MODE, PLAN_MODE } from '../../prompts/planning';
import { RESUME_TRUNCATED_ANSWER } from '../../prompts/recovery';
import * as recovery from '../../prompts/recovery';
import { agentConfig } from '../../core/config';
import { runTurn } from './turn';
import { createAgentState } from '../state';
import { namedMcpServers } from '../intent';
import { loadMcpServers, mcpReady, mcpServerStatus } from '../../mcp/registry';
import { stopResult } from './helpers';
import { applyRuntimeConfig } from './config';
import { buildTurnContext } from './context';
import type { Profile } from './context';

type TurnResult = import('../../protocol.ts').TurnResult;
type Message = import('../../types.ts').Message;

/**
 * The model answered the requests that showed the ended background processes: they are no longer news. A turn that
 * was cancelled or threw may never have had that answer, so what it showed stays pending for the next one.
 */
function settleBackground(workspace: { state?: { background?: { settle(): void } } | null }, result: TurnResult | undefined): void {
  if (!result || result.stopReason === STOP_REASONS.CANCELLED) return;
  workspace.state?.background?.settle();
}

export async function executeTurn({
  provider,
  model,
  workspace,
  history,
  input,
  systemExtra = [],
  gateway,
  toolRunner,
  onStepComplete,
  onNote,
  resumeAvailable = false,
  toolsEnabled = true,
  includeAutoContext = true,
  signal,
  onDelta,
  onReasoning,
  onStatus,
  onToolResult,
  onToolStart,
  onCommandOutput,
  onTelemetry,
  onThinkingSuppressed,
  onGenerationRate,
  onReasoningLeak,
  approve,
  ask,
  onMentions,
  /** Plan mode (--plan, /plan, Shift+Tab): nothing changes until the person approves the plan present_plan shows. */
  planMode = false,
  /** The person turned review mode on; nothing may be changed this turn. */
  reviewMode = false,
  askMode = false,
  onModeSwitch,
  agentState,
  /** The person chose to continue unfinished work (/continue); nothing reads it from the wording. */
  continuing = false,
}: any): Promise<TurnResult> {
  // 1. Config (per-turn overrides on top of the file config).
  const config = applyRuntimeConfig(agentConfig(), workspace);

  // 2. Agent state box.
  const box = agentState ?? createAgentState();
  const rawInput = String(input ?? '');
  box.task = rawInput;
  // Earlier turns' requests compact like any history; the summary keeps them.
  history.releasePins();

  if (box.permissions) {
    box.permissions.denied = false;
    box.permissions.deniedTool = null;
  }

  if (!resumeAvailable && continuing && history.messages.length === 0) {
    return stopResult("There's nothing to continue yet — this is a fresh conversation. What would you like me to do?", STOP_REASONS.COMPLETE);
  }

  // 3. MCP servers the request names.
  const configured = mcpServerStatus().map((server) => server.name);
  const requestedMcpNames = namedMcpServers(rawInput, configured);
  // Servers connect in the background: one this request names may still be starting, and is not missing yet.
  if (requestedMcpNames.length) {
    onStatus?.(`Waiting for MCP ${requestedMcpNames.join(', ')} to start`);
    await mcpReady();
  }
  const mcpStatus = mcpServerStatus();
  const missingMcp = requestedMcpNames.filter((name) => {
    const server = mcpStatus.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    return !server?.connected;
  });
  const mcpGap = missingMcp.length ? recovery.mcpServerUnavailable(missingMcp) : null;
  if (requestedMcpNames.length) loadMcpServers(requestedMcpNames);

  // Plan mode ends the moment present_plan is approved: the person sees Agent mode from the next step on, not when the
  // turn is over. Read off the state the tool set, at the step boundary.
  let planning = false;
  let switched = false;
  const switchWhenApproved = () => {
    // Agent mode asked for plan mode (enter_plan_mode): from here on this turn plans, as if the person had chosen it.
    if (!planning && workspace.state?.planExploring) {
      planning = true;
      try { onModeSwitch?.('plan'); } catch {}
      return;
    }
    if (!planning || switched || !workspace.state || workspace.state.planExploring) return;
    switched = true;
    try { onModeSwitch?.('agent'); } catch {}
  };

  const callbacks = {
    onDelta, onReasoning, onStatus, onToolStart, onCommandOutput, onTelemetry,
    onThinkingSuppressed, onGenerationRate, onReasoningLeak, note: onNote,
    onToolResult: (...args: any[]) => {
      onToolResult?.(...args);
      switchWhenApproved();
    },
  };

  // 4. Prompt context (system + memory + mentions + auto-context).
  const { system, mentions, profile }: { system: Message[]; mentions: string[]; profile: Profile } =
    await buildTurnContext({
      workspace,
      toolsEnabled,
      input: rawInput,
      includeAutoContext,
      signal,
    });
  if (mentions.length) onMentions?.(mentions);
  if (systemExtra.length) system.push(...systemExtra);

  const askOnly = askMode && !reviewMode;
  const readOnly = reviewMode || askOnly;
  planning = planMode && toolsEnabled && !readOnly;

  if (workspace.state) {
    workspace.state.reviewOnly = readOnly;
    // Until present_plan is approved, calls that change something are refused (see the tool runtime).
    workspace.state.planExploring = planning;
  }
  if (reviewMode) system.push({ role: ROLE.SYSTEM, content: REVIEW_MODE });
  else if (askOnly) system.push({ role: ROLE.SYSTEM, content: ASK_MODE });
  else if (planning) system.push({ role: ROLE.SYSTEM, content: PLAN_MODE });

  // 5. Truncated-answer resume.
  const turnInput = continuing && workspace.state?.pendingOutputContinuation ? RESUME_TRUNCATED_ANSWER : rawInput;
  if (workspace.state) workspace.state.pendingOutputContinuation = false;

  // What this session cannot do is the harness's to say, not the person's: it rides with the turn's system context.
  if (mcpGap) system.push({ role: ROLE.SYSTEM, content: mcpGap });
  history.addUser(turnInput, { pinned: true });

  if (workspace.state) {
    workspace.state.permissions = box.permissions;
    workspace.state.agentState = box;
    workspace.state.tunnel = workspace.tunnel;
  }

  // 6. Run the turn.
  let result: TurnResult | undefined;
  try {
    result = await runTurn({
      provider,
      model,
      history,
      systemMessages: system,
      toolsEnabled,
      toolProfile: {
        compact: profile.compact,
        core: profile.core,
        native: workspace.nativeTools !== false,
        readOnly,
      },
      config,
      cwd: workspace.cwd,
      state: workspace.state,
      signal,
      approve,
      ask,
      gateway: gateway ? Object.assign(gateway, { config }) : undefined,
      toolRunner,
      callbacks: { ...callbacks, onStepComplete },
    });
  } finally {
    switchWhenApproved();
    if (workspace.state) workspace.state.planExploring = false;
    settleBackground(workspace, result);
  }

  const answer = String(result?.content ?? '').trim();
  // Mid-turn scaffolding is dropped on save, so the answer already recorded before it still counts as last.
  const last = history.messages.findLast((m: Message) => !(m.id && history.ephemeralIds.has(m.id)));
  if (answer && !(last?.role === ROLE.ASSISTANT && last?.content === result.content)) {
    history.addAssistant(result.content);
  }
  if (workspace.state) {
    workspace.state.pendingOutputContinuation =
      result?.stopReason === STOP_REASONS.OUTPUT_TRUNCATED;
  }
  return result;
}
