import { dim, green, icons } from '../../../ui/ansi';
import { asCompactable, compactForRecovery, liveTurnStart } from '../../../context/builder';
import { CmdResult } from './types';

type Message = import('../../../types.ts').Message;

/** Older turns kept after /compact: room for the last few exchanges once their tool output is cleared. */
const COMPACT_TOKENS = 4_000;
/** What the summary request may send of the older conversation, and how long a reply it asks for. */
const SUMMARY_SOURCE_CHARS = 60_000;
const SUMMARY_REPLY_TOKENS = 1_024;

const SUMMARY_INSTRUCTION =
  'Summarize the conversation below so the work can continue without it. Keep: what the person asked for, decisions ' +
  'made, files created or changed (with paths), commands that were run and how they went, and what is still open. ' +
  'Plain bullet points, no more than about 250 words. Do not call tools.';

/** The older conversation as plain text for the summary request: newest kept when it is too long, tool output cut short. */
function transcript(messages: readonly Message[]): string {
  const lines = messages.map((m) => {
    const text = String(m.content ?? '').trim();
    const calls = (m.tool_calls ?? []).map((c) => `[called ${c.function?.name}]`).join(' ');
    if (m.role === 'tool') return `tool ${m.name ?? ''}: ${text.slice(0, 300)}`;
    return `${m.role}: ${[text, calls].filter(Boolean).join(' ')}`;
  });
  return lines.join('\n').slice(-SUMMARY_SOURCE_CHARS);
}

/** One tool-free request for a summary of what is about to be trimmed; null when it cannot be had. */
async function summarize(ctx: any, older: readonly Message[]): Promise<string | null> {
  try {
    const { createModelGateway } = await import('../../../model/gateway');
    const gateway = createModelGateway({
      provider: ctx.session.provider,
      model: ctx.session.model,
      config: { ...ctx.cfg?.agent, contextWindow: ctx.workspace?.contextWindow, maxTokens: SUMMARY_REPLY_TOKENS },
      tunnel: Boolean(ctx.workspace?.state?.tunnel),
    });
    const called = await gateway.stream({
      messages: [{ role: 'system', content: SUMMARY_INSTRUCTION }, { role: 'user', content: transcript(older) }],
      tools: [],
      think: false,
      replyBudget: SUMMARY_REPLY_TOKENS,
    });
    return String(called.result?.content ?? '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Trims the conversation now, the way the context trims itself when full: the latest request and its work stay whole,
 * older tool output is cleared, and the oldest messages go, leaving one line that says how many. `/compact summary`
 * first asks the model for a short summary of what goes, and keeps that instead of only the count.
 */
export async function runCompact(ctx: any, arg: string = ''): Promise<boolean | 'exit'> {
  const history = ctx.history;
  const before = { messages: history.messages.length, tokens: history.tokenCount };
  const wantSummary = /^summar/i.test(String(arg).trim());
  const older = history.messages.slice(0, liveTurnStart(history));
  let summary: string | null = null;
  if (wantSummary && older.length > 0) {
    ctx.write(`  ${dim(`asking ${ctx.session?.model ?? 'the model'} to summarize ${older.length} older messages…`)}\n`);
    summary = await summarize(ctx, older);
  }
  const { dropped } = compactForRecovery(asCompactable(history), COMPACT_TOKENS);
  history.contextNotice = { near: false, dropped: 0 };
  if (summary && dropped > 0) {
    const live = asCompactable(history);
    live.preservedSummary = [`Summary of the earlier conversation:\n${summary}`, live.preservedSummary].filter(Boolean).join('\n\n');
  }
  if (dropped === 0 && history.tokenCount >= before.tokens) {
    ctx.write(`  ${dim('Nothing to compact — the conversation is already small.')}\n`);
    return CmdResult.HANDLED;
  }
  ctx.persist?.();
  // The status line shows what the last request sent; it is that much smaller now, not only from the next request on.
  const freed = before.tokens - history.tokenCount;
  if (history.lastBudget && freed > 0) {
    const inputTokens = Math.max(0, history.lastBudget.inputTokens - freed);
    const limit = history.lastBudget.contextLimit;
    history.lastBudget = { ...history.lastBudget, inputTokens, historyNeeded: history.tokenCount, utilization: limit > 0 ? inputTokens / limit : 0 };
  }
  const removed = before.messages - history.messages.length;
  const kept = summary && dropped > 0
    ? 'A summary of what was removed is kept for the model.'
    : wantSummary && !summary ? 'No summary could be made, so only the trim was done.'
    : removed === 0
      // Nothing older than the latest request was left: all of it is that request and its work, which is never cut.
      ? 'Nothing older could go: the rest is your latest request and its work, which is kept whole. /clear starts fresh.'
      : 'Your latest request and its work are kept, with the most recent exchanges that fit.';
  const what = removed > 0 ? `${removed} older messages removed` : 'old tool output shortened';
  ctx.write(`  ${green(icons.ok)} compacted ${dim(`— ${what}, ~${before.tokens} → ~${history.tokenCount} tokens. ${kept}`)}\n`);
  return CmdResult.HANDLED;
}
