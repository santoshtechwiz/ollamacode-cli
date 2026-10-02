// Stop guards read one round of the turn: what the model asked for and what it was shown back.

import { isGateRefusal } from '../../protocol';
import { signatureOf, type ToolCallRecord, type TurnState } from './turn-state';

interface RoundSummary {
  executed: number;
  reused: number;
  reusedAgain: number;
  /** Ran, but the tool said it found what an earlier call found: a reworded repeat. */
  nothingNew: number;
  /** Nothing-new calls repeated after the notice an earlier round gave: the stall. */
  nothingNewAgain: number;
  rejected: number;
  refusedOnly: boolean;
  repeatsEarlier: boolean;
}

/** The calls settled in one round. */
function roundCalls(state: TurnState, iteration: number): ToolCallRecord[] {
  return state.toolCalls.filter((c) => c.at === iteration);
}

function wasReused(c: ToolCallRecord): boolean {
  return c.isRepeat && c.result.data?.reused === true;
}

/** A call that ran and found something: not a repeat, and not a reworded repeat the tool recognised. */
function didWork(c: ToolCallRecord): boolean {
  return !c.isRepeat && !c.foundNothingNew;
}

/** What a nothing-new call found, as the tool keyed it. */
function findingKey(c: ToolCallRecord): string {
  return `${c.name}\u0000${c.resultKey}`;
}

function wasRejectedRepeat(c: ToolCallRecord): boolean {
  return (c.result.data as { notRunRepeat?: boolean } | undefined)?.notRunRepeat === true;
}

/**
 * Exactly what the model was shown for one round:
 * which calls it made, and what came back.
 */
function roundOutput(state: TurnState, iteration: number): string {
  return roundCalls(state, iteration)
    .map((c) => `${c.name}:${JSON.stringify(c.args)}\n${c.rendered ?? ''}`)
    .join('\n');
}

/**
 * Every call in the round drew a standing refusal.
 * Re-asking can only reproduce the same refusals.
 */
function roundIsRefusalOnly(calls: ToolCallRecord[]): boolean {
  return (
    calls.length > 0 &&
    calls.every((c) => {
      // A refusal that only loaded the schema invites the retry; counting it would end the turn right before real work.
      if (c.schemaPending) return false;
      if (wasRejectedRepeat(c)) return true;
      // A gate (policy, approval, plan, scope) refuses an identical retry the same way; bad arguments are the model's to fix.
      return !c.result?.ok && isGateRefusal(c.result?.code);
    })
  );
}

/**
 * The round showed the model exactly what an earlier round
 * already showed it. This is a fixed point.
 */
function roundRepeatsEarlier(state: TurnState, iteration: number): boolean {
  const current = roundOutput(state, iteration);
  if (!current) return false;
  for (let earlier = 1; earlier < iteration; earlier += 1) {
    if (roundOutput(state, earlier) === current) return true;
  }
  return false;
}

export function summarizeRound(state: TurnState, iteration: number): RoundSummary {
  const round = roundCalls(state, iteration);
  const reused = round.filter(wasReused);
  // A first reuse hands back a result whose original may have been cleared from context; asking again after that notice is the stall.
  const reusedBefore = new Set(
    state.toolCalls
      .filter((c) => c.at < iteration && wasReused(c))
      .map(signatureOf),
  );

  const nothingNew = round.filter((c) => c.foundNothingNew);
  // The same rule as a reuse: the first nothing-new result carries a notice; finding nothing new again after it is the stall.
  const notifiedBefore = new Set(
    state.toolCalls.filter((c) => c.at < iteration && c.foundNothingNew).map(findingKey),
  );

  return {
    executed: round.filter(didWork).length,
    reused: reused.length,
    reusedAgain: reused.filter((c) => reusedBefore.has(signatureOf(c))).length,
    nothingNew: nothingNew.length,
    nothingNewAgain: nothingNew.filter((c) => notifiedBefore.has(findingKey(c))).length,
    rejected: round.filter(wasRejectedRepeat).length,
    refusedOnly: roundIsRefusalOnly(round),
    repeatsEarlier: roundRepeatsEarlier(state, iteration),
  };
}
