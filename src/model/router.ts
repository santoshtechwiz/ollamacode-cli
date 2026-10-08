export interface Candidate {
  name: string;
  supportsTools?: boolean;
  contextLength?: number;
  sizeBytes?: number;
  remote?: boolean;
  resident?: boolean;
  tokensPerSec?: number;
}

interface Requirements {
  needsTools?: boolean;
  minContext?: number;
  prefersSpeed?: boolean;
  memoryBudgetBytes?: number;
}

const OVERSIZED_PENALTY = 50;

export interface RoutingPolicy {
  enabled?: boolean;
  speed?: boolean;
  allowRemote?: boolean;
  pinned?: string;
  maxModelBytes?: number | null;
}

const COST_RELOAD = 'reload';
const COST_FREE = 'free';

function switchCost(from: Candidate | null, to: Candidate): 'free' | 'reload' {
  if (from && from.name === to.name) return COST_FREE;
  if (to.remote) return COST_FREE;
  if (to.resident) return COST_FREE;
  return COST_RELOAD;
}

function meetsRequirements(candidate: Candidate, requirements: Requirements): boolean {
  if (requirements.needsTools && candidate.supportsTools === false) return false;
  if (
    requirements.minContext &&
    candidate.contextLength !== undefined &&
    candidate.contextLength < requirements.minContext
  ) {
    return false;
  }
  return true;
}

function score(candidate: Candidate, requirements: Requirements): number {
  let value = 0;
  if (requirements.needsTools && candidate.supportsTools === true) value += 100;

  if (
    requirements.memoryBudgetBytes &&
    candidate.sizeBytes &&
    !candidate.remote &&
    candidate.sizeBytes > requirements.memoryBudgetBytes
  ) {
    value -= OVERSIZED_PENALTY;
  }

  if (requirements.prefersSpeed) {
    if (candidate.tokensPerSec) value += Math.min(candidate.tokensPerSec, 100);
    else if (candidate.sizeBytes) value += Math.max(0, 40 - (candidate.sizeBytes / 1e9) * 4);
    return value;
  }

  if (candidate.sizeBytes) value += Math.min(candidate.sizeBytes / 1e9, 30);
  return value;
}

export function chooseModel({ current, candidates, requirements, policy = {} }: { current: Candidate | null; candidates: Candidate[]; requirements: Requirements; policy?: RoutingPolicy; }): { model: string; reason: string; cost: 'free' | 'reload'; } | null {
  const { enabled = true, speed = false, allowRemote = false, pinned } = policy;
  if (!enabled) return null;
  if (pinned && current && current.name === pinned) return null;

  const usable = candidates.filter((c) => {
    if (!allowRemote && c.remote) return false;
    return meetsRequirements(c, requirements);
  });
  if (usable.length === 0) return null;

  const best = [...usable].sort(
    (a, b) => score(b, requirements) - score(a, requirements) || a.name.localeCompare(b.name),
  )[0];
  if (current && best.name === current.name) return null;

  if (!current || !meetsRequirements(current, requirements)) {
    return { model: best.name, reason: gapReason(current, requirements), cost: switchCost(current, best) };
  }

  if (!speed || !requirements.prefersSpeed) return null;
  const cost = switchCost(current, best);
  if (cost !== COST_FREE) return null;

  return { model: best.name, reason: `${best.name} is faster and already loaded`, cost };
}

function gapReason(current: Candidate | null, requirements: Requirements): string {
  if (!current) return 'no model was selected';
  if (requirements.needsTools && current.supportsTools === false) {
    return `${current.name} has no tool-calling template`;
  }
  if (requirements.minContext) {
    return `${current.name} cannot fit this turn's context`;
  }
  return `${current.name} cannot handle this turn`;
}

export function describeChoice(choice: { model: string; reason: string; cost: 'free' | 'reload'; }): string {
  const note = choice.cost === COST_RELOAD ? ' — this needs a model load' : '';
  return `switching to ${choice.model}: ${choice.reason}${note}`;
}

