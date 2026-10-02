import { agentConfig } from '../../core/config';
import { THINKING_MODE, type ThinkingMode, REASONING_MIN_TOKENS_PER_SEC } from '../../protocol';
import type { Workspace } from './session';

/** Why a thinking-capable model was not asked to think. */
export type ThinkingSuppression = 'unaffordable' | 'exhausted';

/** Does the model get asked to think? */
export function resolveThinking(workspace: Workspace): void {
  const configured = agentConfig().thinking;

  // Only two things can force reasoning *on*: a `--think`/`/think` given for this session.
  const forcedOff =
    workspace.thinkingPreference === THINKING_MODE.HIDE || configured === THINKING_MODE.HIDE;
  const forcedOn =
    workspace.thinkingPreference === THINKING_MODE.SHOW ||
    workspace.thinkingPreference === THINKING_MODE.DETAILED;

  if (workspace.supportsThinking !== true || forcedOff) {
    workspace.thinkingEnabled = false;
    workspace.thinkingSuppressed = null;
    return;
  }
  if (forcedOn) {
    // The user said so, here, now.
    workspace.thinkingEnabled = true;
    workspace.thinkingSuppressed = null;
    return;
  }

  // Once reasoning has exhausted a reply this session it stays off, like an explicit /think off.
  if (workspace.thinkingSuppressed === 'exhausted') {
    workspace.thinkingEnabled = false;
    return;
  }

  workspace.thinkingEnabled = true;
  // Remote backends are assumed fast; local speed is only what was measured. Informational: it only drives the slow warning.
  const affordable = workspace.remote === true
    || (workspace.tokensPerSec !== undefined && workspace.tokensPerSec >= REASONING_MIN_TOKENS_PER_SEC);
  workspace.thinkingSuppressed = affordable ? null : 'unaffordable';
}

/** A `/think` or `--think` choice, applied for the rest of the session. */
export function setThinkingPreference(workspace: Workspace, mode: ThinkingMode): void {
  workspace.thinkingPreference = mode;
  resolveThinking(workspace);
}

/** A reply came back with reasoning in the answer channel although the call asked for none. */
export function recordReasoningLeak(workspace: Workspace): boolean {
  if (workspace.reasoningLeaks) return false;
  workspace.reasoningLeaks = true;
  return true;
}

/** What this backend actually generates at, measured on a completed call. */
export function recordGenerationRate(workspace: Workspace, tokensPerSec: number): boolean {
  if (!Number.isFinite(tokensPerSec) || tokensPerSec <= 0) return false;
  // Keep the best rate seen: a call that generated three tokens measures noise, not the backend.
  workspace.tokensPerSec = Math.max(workspace.tokensPerSec ?? 0, tokensPerSec);
  const before = workspace.thinkingEnabled;
  resolveThinking(workspace);
  return workspace.thinkingEnabled !== before;
}

/** Give up on thinking for the rest of the session, after a reply spent its entire budget on it and produced no answer and no tool calls. */
export function suppressThinking(workspace: Workspace): boolean {
  if (!workspace.thinkingEnabled) return false;
  workspace.thinkingEnabled = false;
  workspace.thinkingSuppressed = 'exhausted';
  return true;
}

