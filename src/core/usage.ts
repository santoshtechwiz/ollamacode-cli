// Tokens sent to and received from models in this session; the model gateway is the one writer, so planner and summary calls count too.

export interface UsageCount {
  sent: number;
  received: number;
  calls: number;
  /** Calls whose counts ocode estimated because the backend reported none. */
  estimated: number;
}

export interface UsageTotals extends UsageCount {
  byModel: Record<string, UsageCount>;
}

/** One finished turn, kept so /usage can name the heavy ones. */
export interface TurnUsage extends UsageCount {
  request: string;
}

const empty = (): UsageCount => ({ sent: 0, received: 0, calls: 0, estimated: 0 });

let totals: UsageTotals = { ...empty(), byModel: {} };

export function recordUsage(model: string, { sent, received, estimated }: { sent: number; received: number; estimated: boolean }): void {
  const row = (totals.byModel[model] ??= empty());
  for (const count of [totals, row]) {
    count.sent += Math.max(0, Math.round(sent));
    count.received += Math.max(0, Math.round(received));
    count.calls += 1;
    if (estimated) count.estimated += 1;
  }
}

export function usageTotals(): UsageTotals {
  return structuredClone(totals);
}

/** What was used since `before` was taken: one turn's share. */
export function usageSince(before: UsageTotals): UsageCount {
  return {
    sent: totals.sent - before.sent,
    received: totals.received - before.received,
    calls: totals.calls - before.calls,
    estimated: totals.estimated - before.estimated,
  };
}

/** Start over, or carry on from a resumed session's totals. */
export function resetUsage(from?: UsageTotals | null): void {
  const copy = from && Number.isFinite(from.sent) ? structuredClone(from) : null;
  totals = { ...empty(), ...copy, byModel: copy?.byModel ?? {} };
}

/** "940", "12.4k", "1.2M" — with "~" when any of it was estimated. */
export function formatTokens(n: number, estimated = false): string {
  const approx = estimated ? '~' : '';
  if (n < 1000) return `${approx}${n}`;
  if (n < 1_000_000) return `${approx}${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${approx}${(n / 1_000_000).toFixed(1)}M`;
}

/** "12.4k sent · 640 received · 5 model calls"; `pad` right-aligns the counts for a column. */
export function usageLine(u: UsageCount, callWord = 'model call', pad: [number, number] = [0, 0]): string {
  const approx = u.estimated > 0;
  return `${formatTokens(u.sent, approx).padStart(pad[0])} sent · ${formatTokens(u.received, approx).padStart(pad[1])} received · ${u.calls} ${callWord}${u.calls === 1 ? '' : 's'}`;
}

/** One turn as a line: "this turn: 12.4k sent · 640 received · 5 model calls". */
export function describeTurnUsage(u: UsageCount): string {
  return `this turn: ${usageLine(u)}`;
}
