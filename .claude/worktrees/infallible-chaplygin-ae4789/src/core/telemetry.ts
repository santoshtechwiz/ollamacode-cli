export interface ModelCallRecord {
  model: string;
  attempt: number;
  retries: number;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  /** Reasoning's share of `completionTokens`, estimated from the characters that came back on the reasoning channel. */
  reasoningTokens?: number;
  /** Whether this call asked the model to reason. */
  thinking?: boolean;
  promptMs?: number;
  genMs?: number;
  loadMs?: number;
  promptTokensPerSec?: number;
  genTokensPerSec?: number;
}

export function recordModelCall(
  result: import('../types.ts').StreamChatResult,
  { model, attempt, retries, startedAt, reasoningTokens, thinking }: any
): ModelCallRecord {
  return {
    model,
    attempt,
    retries,
    latencyMs: Math.max(0, Date.now() - startedAt),
    promptTokens: result.usage?.promptTokens,
    completionTokens: result.usage?.completionTokens,
    reasoningTokens,
    thinking,
    promptMs: result.metrics?.promptMs,
    genMs: result.metrics?.genMs,
    loadMs: result.metrics?.loadMs,
    promptTokensPerSec: result.metrics?.promptTokensPerSec,
    genTokensPerSec: result.metrics?.genTokensPerSec,
  };
}

export interface TelemetrySummary {
  calls: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalReasoningTokens: number;
  totalLatencyMs: number;
  totalLoadMs: number;
  /** Any call reported prompt/completion counts — without one, `0` below is absence, not a measurement. */
  hasPromptTokens: boolean;
  hasCompletionTokens: boolean;
  /** Weighted by tokens, not a mean of means — a one-token call must not skew it. */
  genTokensPerSec?: number;
  promptTokensPerSec?: number;
}

export function summarizeTelemetry(records: ModelCallRecord[]): TelemetrySummary {
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalReasoningTokens = 0;
  let totalLatencyMs = 0;
  let totalLoadMs = 0;
  let genMs = 0;
  let promptMs = 0;
  let hasPromptTokens = false;
  let hasCompletionTokens = false;
  for (const r of records) {
    if (r.promptTokens != null) {
      hasPromptTokens = true;
      totalPromptTokens += r.promptTokens;
    }
    if (r.completionTokens != null) {
      hasCompletionTokens = true;
      totalCompletionTokens += r.completionTokens;
    }
    totalReasoningTokens += r.reasoningTokens ?? 0;
    totalLatencyMs += r.latencyMs;
    totalLoadMs += r.loadMs ?? 0;
    genMs += r.genMs ?? 0;
    promptMs += r.promptMs ?? 0;
  }
  return {
    calls: records.length,
    totalPromptTokens,
    totalCompletionTokens,
    totalReasoningTokens,
    totalLatencyMs,
    totalLoadMs,
    hasPromptTokens,
    hasCompletionTokens,
    genTokensPerSec: genMs > 0 ? totalCompletionTokens / (genMs / 1000) : undefined,
    promptTokensPerSec: promptMs > 0 ? totalPromptTokens / (promptMs / 1000) : undefined,
  };
}

/** The summary as one line. */
export function formatTelemetry(s: TelemetrySummary): string {
  const rate = (n?: number) => (n ? `${Math.round(n)} tok/s` : '—');
  const reasoning = s.totalReasoningTokens
    ? ` (${s.totalReasoningTokens} reasoning)`
    : '';
  // Token totals print only when some call really reported them — §21: a `0` where the wire said nothing is a fake, not a measurement.
  const prompt = s.hasPromptTokens
    ? `${s.totalPromptTokens} prompt @ ${rate(s.promptTokensPerSec)}`
    : 'prompt totals unavailable';
  const gen = s.hasCompletionTokens
    ? `${s.totalCompletionTokens} gen${reasoning} @ ${rate(s.genTokensPerSec)}`
    : 'generation totals unavailable';
  return (
    `${s.calls} call(s) · ${(s.totalLatencyMs / 1000).toFixed(1)}s · ` +
    `${prompt} · ` +
    `${gen}` +
    (s.totalLoadMs ? ` · ${Math.round(s.totalLoadMs)}ms model load` : '')
  );
}
