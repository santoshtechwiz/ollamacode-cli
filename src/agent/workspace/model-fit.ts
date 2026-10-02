// How well a model suits coding with tools, judged from what the backend reports about it, never from a list of model names.

export type ModelFit = 'ready' | 'limited' | 'unsuited';

export interface ModelFacts {
  model: string;
  /** False when the backend declares no tool support, so tools fall back to text instructions. */
  nativeTools?: boolean;
  /** As the backend reports it: "4.0B", "567M", "14.8B". */
  parameterSize?: string;
  /** The window the session drives the model at. */
  contextLength?: number;
  cpuOnly?: boolean;
  remote?: boolean;
}

export interface ModelVerdict {
  fit: ModelFit;
  /** One plain sentence for the person choosing: what it can do, what will go wrong. */
  message: string;
}

/** Below this many parameters, multi-step edits (plan, edit, test in one request) were unreliable in live runs. */
export const SMALL_MODEL_BILLIONS = 7;
/** A window this short forgets earlier reads within one task. */
export const SHORT_WINDOW = 16_384;
/** A window this short cannot hold the system prompt, tools and a file at once. */
export const UNUSABLE_WINDOW = 8_192;

/** "4.0B" → 4, "567M" → 0.567; undefined when the backend gave nothing usable. */
export function parameterBillions(size: string | undefined): number | undefined {
  const match = /^\s*([\d.]+)\s*([BMK])/i.exec(String(size ?? ''));
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const scale = { B: 1, M: 1e-3, K: 1e-6 }[match[2].toUpperCase() as 'B' | 'M' | 'K'];
  return value * scale;
}

function windowLabel(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens);
}

export function judgeModel(facts: ModelFacts): ModelVerdict {
  const name = facts.model;
  const window = Number(facts.contextLength) || 0;

  if (facts.nativeTools === false) {
    return {
      fit: 'unsuited',
      message: `${name} has no tool support, so tools fall back to text instructions and calls get missed or malformed — pick a model with tool support for coding.`,
    };
  }
  if (window > 0 && window < UNUSABLE_WINDOW) {
    return {
      fit: 'unsuited',
      message: `${name} runs with a ${windowLabel(window)} window, too short to hold the instructions, tools and a file together — pick a model with a larger window for coding.`,
    };
  }

  const billions = parameterBillions(facts.parameterSize);
  const limits: string[] = [];
  if (billions !== undefined && billions < SMALL_MODEL_BILLIONS) limits.push(`is small (${facts.parameterSize!.trim()})`);
  if (window > 0 && window < SHORT_WINDOW) limits.push(`has a short ${windowLabel(window)} window`);
  if (facts.cpuOnly) limits.push('runs on CPU');

  if (limits.length > 0) {
    const small = billions !== undefined && billions < SMALL_MODEL_BILLIONS;
    const scope = small
      ? 'fine for questions, running commands and precise one-step edits; unreliable at multi-step coding (plan, edit and test in one request)'
      : 'usable for coding, but it forgets earlier reads sooner and needs tasks broken into smaller steps';
    const slow = facts.cpuOnly ? ' Expect minutes per reply.' : '';
    return { fit: 'limited', message: `${name} ${joinLimits(limits)} — ${scope}.${slow}` };
  }

  const known = [
    billions !== undefined ? facts.parameterSize!.trim() : null,
    'tools',
    window > 0 ? `${windowLabel(window)} window` : null,
  ].filter(Boolean).join(' · ');
  const unknownSize = billions === undefined ? ' (size not reported)' : '';
  return { fit: 'ready', message: `${name} is ready for coding with tools — ${known}${unknownSize}.` };
}

function joinLimits(parts: string[]): string {
  return parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
