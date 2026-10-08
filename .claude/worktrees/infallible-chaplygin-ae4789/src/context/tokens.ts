

/** Cold start, before any real call has been seen: ~20% over the ~4 chars/token real traffic shows, so a first request errs large. */
const CHARS_PER_TOKEN = 3.2;

const MESSAGE_OVERHEAD_TOKENS = 4;

const SAFETY = 0.9;

const MIN_RATIO = 1.5;
const MAX_RATIO = 8;

/** Weight of each new sample. Low enough that one odd turn cannot swing the budget. */
const SMOOTHING = 0.3;

let calibrated: { model: string; charsPerToken: number; samples: number; } | null = null;

export function estimateTokens(text: string): number {
  return Math.ceil(String(text ?? '').length / charsPerToken());
}

/** The ratio in force: calibrated for this model, or the conservative default. */
export function charsPerToken(): number {
  return calibrated ? calibrated.charsPerToken : CHARS_PER_TOKEN;
}

/** What has been learned, for the debug log and the context bar. */
export function tokenCalibration(): { model: string; charsPerToken: number; samples: number; } | null {
  return calibrated ? { ...calibrated } : null;
}

export function observePromptTokens(model: string, chars: number, promptTokens: number | undefined) {
  if (!Number.isFinite(promptTokens) || !promptTokens || promptTokens <= 0) return;
  if (!Number.isFinite(chars) || chars <= 0) return;

  const observed = chars / (promptTokens as number);
  if (observed < MIN_RATIO || observed > MAX_RATIO) return;

  const safe = observed * SAFETY;
  if (!calibrated || calibrated.model !== model) {
    calibrated = { model, charsPerToken: safe, samples: 1 };
    return;
  }
  calibrated = {
    model,
    charsPerToken: calibrated.charsPerToken + SMOOTHING * (safe - calibrated.charsPerToken),
    samples: calibrated.samples + 1,
  };
}

/** The billable length of a request, counted the way `observePromptTokens` expects. */
export function promptChars(
  messages: import('../types.ts').Message[],
  tools: unknown[] = []
): number {
  let chars = 0;
  for (const m of messages ?? []) {
    chars += String(m.content ?? '').length;
    for (const call of m.tool_calls ?? []) {
      chars += call.function.name.length + JSON.stringify(call.function.arguments ?? {}).length;
    }
  }
  if (tools?.length) chars += JSON.stringify(tools).length;
  return chars;
}

export function messageTokens(message: import('../types.ts').Message): number {
  let total = estimateTokens(message.content ?? '');
  for (const call of message.tool_calls ?? []) {
    total += estimateTokens(call.function.name);
    total += estimateTokens(JSON.stringify(call.function.arguments ?? {}));
  }
  return total + MESSAGE_OVERHEAD_TOKENS;
}
