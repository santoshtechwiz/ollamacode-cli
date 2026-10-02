import { AGENT_STATE, ROLE, STOP_REASONS } from '../../protocol';
import { REVIEW_MODE, ASK_MODE, EXECUTION_MODE_ACTIVE, RESUME_EXECUTION_INSTRUCTION, executionPin, approvedPlanInput } from '../../prompts/planning';
import { RESUME_TRUNCATED_ANSWER } from '../../prompts/recovery';
import * as recovery from '../../prompts/recovery';
import { agentConfig } from '../../core/config';
import { runTurn } from './turn';
import { selectToolDefs } from '../../context/tool-surface';
import { executionProgress } from '../planning/plan';
import { getPlanPath } from '../planning/store';
import { createAgentState, transition } from '../state';
import { settlePlan } from '../planning/settle';
import { namedMcpServers } from '../intent';
import { loadMcpServers, mcpServerStatus } from '../../mcp/registry';
import { stopResult, clearPlanState } from './helpers';
import { applyRuntimeConfig } from './config';
import { buildTurnContext, detectReplan, applyTaskScope } from './context';
import type { Profile } from './context';
import type { ContextStore } from '../../context/contracts';
import { replyForFinishedPlan, hydrateResumeFromPlan } from '../planning/plan-handling';
import { runPlanApprovalLoop } from '../planning/plan-loop';

type TurnResult = import('../../protocol.ts').TurnResult;
type Message = import('../../types.ts').Message;

/** A shown plan, as plain text a later turn can be compared against and approved. */
function shownPlanText(shown: any): string {
  const raw = typeof shown.raw === 'string' ? shown.raw.trim() : '';
  if (raw) return raw;
  const steps = Array.isArray(shown.steps)
    ? shown.steps.map((step: unknown, i: number) => `${i + 1}. ${typeof step === 'string' ? step : JSON.stringify(step)}`)
    : [];
  return [String(shown.summary ?? '').trim(), ...steps].filter(Boolean).join('\n');
}

/**
 * A stopped plan is still a turn; keep the request and, after it, what the model replied: the plan it showed, or
 * its answer when the request was a question. A plan shown without approval is what the person is approving when
 * they answer "approved" on the next turn; an answer is what a follow-up question builds on.
 */
export function recordStoppedPlan(history: ContextStore, input: string, shown: any, answer?: string): void {
  history.addUser(input, { pinned: true });
  const reply = shown ? shownPlanText(shown) : answer;
  if (reply) history.addAssistant(reply);
}

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
  planMode: planModeIn = false,
  /** The person turned review mode on; nothing may be changed this turn. */
  reviewMode = false,
  askMode = false,
  noPlan = false,
  onPlan,
  onModeSwitch,
  agentState,
  resumePlan = false,
  /** The person chose to continue unfinished work (/continue, or the paused-plan prompt); nothing reads it from the wording. */
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

  // 3. Replan detection — the only place `input` may be replaced.
  const replan = resumePlan ? null : detectReplan(workspace, continuing, toolsEnabled);
  let turnInput = replan?.input ?? rawInput;
  let planMode = planModeIn;
  if (replan) planMode = true;

  // 4. Scope resolution.
  const scope = applyTaskScope(workspace, turnInput, { onStatus });
  const mcpStatus = mcpServerStatus();
  const requestedMcpNames = namedMcpServers(turnInput, mcpStatus.map((server) => server.name));
  const missingMcp = requestedMcpNames.filter((name) => {
    const server = mcpStatus.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
    return !server?.connected;
  });
  const mcpGap = missingMcp.length ? recovery.mcpServerUnavailable(missingMcp) : null;
  if (requestedMcpNames.length) loadMcpServers(requestedMcpNames);

  const callbacks = {
    onDelta, onReasoning, onStatus, onToolResult, onToolStart, onCommandOutput, onTelemetry,
    onThinkingSuppressed, onGenerationRate, onReasoningLeak, note: onNote,
  };

  // 5. Planning is an explicit mode (--plan, /plan, Shift+Tab); the wording of a request never forces it.
  const needPlan = replan != null || Boolean(planMode && toolsEnabled && onPlan && !noPlan);
  const toolsAllowed = toolsEnabled;

  // 7. Prompt context (system + memory + mentions + auto-context).
  const { system, mentions, profile }: { system: Message[]; mentions: string[]; profile: Profile } =
    await buildTurnContext({
      workspace,
      toolsEnabled,
      input: turnInput,
      includeAutoContext,
      signal,
      stacks: scope ? scope.stackInfos : undefined,
    });
  if (mentions.length) onMentions?.(mentions);
  if (systemExtra.length) system.push(...systemExtra);

  const reviewOnly = reviewMode;
  const askOnly = askMode && !reviewOnly;
  const readOnly = reviewOnly || askOnly;

  if (workspace.state) workspace.state.reviewOnly = readOnly;
  if (reviewOnly) system.push({ role: 'system' as const, content: REVIEW_MODE });
  else if (askOnly) system.push({ role: 'system' as const, content: ASK_MODE });

  // 9. Continuing a plan that already ended → answer, don't execute.
  const finishedReply = replyForFinishedPlan({
    workspace, continuing, toolsEnabled, reviewOnly: readOnly, needPlan, box,
  });
  if (finishedReply) return finishedReply;

  // 10. Hydrate a resumable plan from disk (mutates box).
  hydrateResumeFromPlan({ workspace, box, continuing, reviewOnly: readOnly, toolsEnabled });

  const isResume =
    !readOnly && toolsEnabled && box.resumable && box.plan && continuing;

  if (!isResume && !resumeAvailable && continuing && history.messages.length === 0) {
    return stopResult("There's nothing to continue yet — this is a fresh conversation. What would you like me to do?", STOP_REASONS.COMPLETE);
  }

  if (!isResume) {
    clearPlanState(box, workspace);
  }

  if (isResume) {
    transition(box, AGENT_STATE.PLANNING);
    transition(box, AGENT_STATE.WAITING_FOR_APPROVAL);
    transition(box, AGENT_STATE.EXECUTING);
    if (box.permissions) {
      box.permissions.plan_approved = true;
      box.permissions.action_approved = false;
    }
  } else if (needPlan) {
    const outcome = await runPlanApprovalLoop({
      box,
      workspace,
      provider,
      model,
      system,
      task: turnInput,
      config,
      profile,
      signal,
      onPlan,
      replanFrom: replan,
      history,
      gateway,
      toolRunner,
      callbacks,
    });
    if (outcome.kind === 'stop' && outcome.result) {
      recordStoppedPlan(history, turnInput, outcome.shown, outcome.answer);
      settleBackground(workspace, outcome.result);
      return outcome.result;
    }
    // Only an approved plan switches to Agent mode; a change the planner judged too small to plan just proceeds.
    if (outcome.kind === 'proceed' && outcome.approved) {
      if (typeof onModeSwitch === 'function') {
        try { onModeSwitch('agent'); } catch {}
      }
      // The request was for a plan; answering it again would only plan again. The approved plan is the work now.
      const approved = String(box.plan?.presented ?? box.plan?.raw ?? '').trim();
      if (approved) turnInput = approvedPlanInput(approved);
      // Files changed from here on are this plan's; earlier ones in the session are not.
      box.planChangesFrom = (workspace.state?.changes ?? []).length;
      // A task list from before the plan is not this plan's progress.
      if (workspace.state) workspace.state.todos = [];
    }
  }

  // 11. Truncated-answer resume.
  const resumingTruncatedAnswer =
    continuing && Boolean(workspace.state?.pendingOutputContinuation);
  if (resumingTruncatedAnswer) turnInput = RESUME_TRUNCATED_ANSWER;
  if (workspace.state) workspace.state.pendingOutputContinuation = false;

  if (mcpGap) history.addUser(mcpGap, { pinned: true });
  if (box.plan?.raw) {
    const pin = executionPin(executionProgress(box.plan, workspace.state?.changes ?? []));
    if (pin) {
      system.push({ role: 'system' as const, content: EXECUTION_MODE_ACTIVE });
      // Picking the plan up again needs the progress so far; the turn that starts it already carries the whole plan.
      if (resumePlan || isResume) {
        history.addUser(pin, { pinned: true, slot: 'execution' });
        system.push({ role: 'system' as const, content: RESUME_EXECUTION_INSTRUCTION });
      }
    }
  }
  history.addUser(turnInput, { pinned: true });

  // 13. Publish state for the loop / tools.
  if (workspace.state) {
    workspace.state.plan = box.plan;
    workspace.state.permissions = box.permissions;
    workspace.state.agentState = box;

    if (box.plan) {
      workspace.state.planPath = workspace.state.planPath ?? getPlanPath(workspace.cwd);
    }
    workspace.state.tunnel = workspace.tunnel;
  }

  // 14. Run the turn.
  let result: TurnResult | undefined;
  try {
    result = await runTurn({
      provider,
      model,
      history,
      systemMessages: system,
      toolsEnabled,
      toolsAllowed,
      toolProfile: {
        compact: profile.compact,
        core: profile.core,
        native: workspace.nativeTools !== false,
        readOnly,
        // Every tool the profile allows goes out in full: a model that must ask for a tool first often writes the call as text instead.
        always: selectToolDefs({ core: profile.core, readOnly }).map((def) => def.name),
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
    settlePlan({ box, workspace, result });
    settleBackground(workspace, result);
  }

  // Settlement may promote a completed plan's stop reason; the plan's checklist rides on planChecklist, never in history.
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
