import { clearToolResults, evictOldest, type CompactionStrategy } from '@tanstack/ai-compaction';
import type { ModelMessage } from '@tanstack/ai';
import { ROLE } from '../protocol';
import { logger } from '../core/logger';
import type { Message, ToolSchema } from '../types';
import { messageTokens, estimateTokens, tokenCalibration, charsPerToken } from './tokens';
import { describeSession, describeProject, type WorkspaceState } from './workspace-state';
import { describeExitsForModel } from '../tool/process/background-inbox';
import { textModeInstructions } from '../prompts/tools';
import { EXECUTION_PIN_LEAD } from '../prompts/planning';
import type { ContextBudget, ContextStore, PreparedContext } from './contracts';

const CONTEXT_OPEN = '[Workspace context: for reference only; answer the request after it, and use this only if the request is about this project]';
const CONTEXT_CLOSE = '[End of workspace context]';

/** Share of the window's prompt room that older turns may fill when config sets no history budget. */
const HISTORY_SHARE = 0.5;
/** History target when neither the window nor a retry cap is known. */
const UNKNOWN_WINDOW_HISTORY = 8_000;
/**
 * Older turns never take more than this unless agent.contextBudget says otherwise, however big the window: a day of
 * finished tasks sent with every question made replies slow and gave small models old work to redo.
 */
export const DEFAULT_HISTORY_TOKENS = 16_000;

const sumTokens = (list: readonly Message[]): number => list.reduce((sum, m) => sum + messageTokens(m), 0);

/**
 * A finished turn's tool output has done its job: what it showed is in that turn's answer, and a file read then may
 * not read the same now. Its first line still says what ran and how it went; the rest is read again if needed.
 */
function settledToolResult(m: Message): Message {
  const content = String(m.content ?? '');
  const head = content.split('\n')[0];
  return head === content ? m : { ...m, content: `${head}\n[output from an earlier request omitted]` };
}

/** Longest argument value a finished turn's call keeps whole; a file body or a long edit is cut to its start. */
const SETTLED_ARG_CHARS = 200;

/**
 * A finished turn's tool call: which tool, on what. A file body it wrote or an edit's text is in the file now, and is
 * read from there if needed; carried here it is the bulk of every later request.
 */
function settledToolCall(m: Message): Message {
  let cut = false;
  const shorten = (value: unknown): unknown => {
    if (typeof value === 'string' && value.length > SETTLED_ARG_CHARS) {
      cut = true;
      return `${value.slice(0, 80)}… [${value.length - 80} more chars omitted]`;
    }
    if (Array.isArray(value)) return value.map(shorten);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
    return value;
  };
  const toolCalls = m.tool_calls!.map((call) => ({ ...call, function: { ...call.function, arguments: shorten(call.function.arguments) as Record<string, unknown> } }));
  return cut ? { ...m, tool_calls: toolCalls } : m;
}

/** A message from a finished turn, as later requests carry it. */
function settledMessage(m: Message): Message {
  if (m.role === ROLE.TOOL) return settledToolResult(m);
  if (m.role === ROLE.ASSISTANT && m.tool_calls?.length) return settledToolCall(m);
  return m;
}

/** The person's live request: the message a model reply must answer, never scaffolding. */
function isTurnRequest(m: Message, ephemeralIds: ReadonlySet<string>): boolean {
  return m.role === ROLE.USER && !ephemeralIds.has(String(m.id)) && !String(m.content ?? '').startsWith(EXECUTION_PIN_LEAD);
}

/** Where the live turn begins: its request, the last one the person sent. Everything from here on is never compacted. */
export function liveTurnStart(store: Pick<CompactableStore, 'messages' | 'ephemeralIds'>): number {
  const from = store.messages.findLastIndex((m) => isTurnRequest(m, store.ephemeralIds));
  return from < 0 ? store.messages.length : from;
}

/** The existing pins plus every index from `from` to the end: the live turn, kept whole. */
function pinnedFrom(pins: ReadonlySet<number>, from: number, length: number): Set<number> {
  return new Set([...pins, ...Array.from({ length: length - from }, (_, k) => from + k)]);
}

/** The mutable shape of a live conversation a reactive compaction may shrink. */
interface CompactableStore {
  messages: Message[];
  pinnedIndices: Set<number>;
  ephemeralIds: Set<string>;
  preservedSummary: string | null;
}

/** What a compaction rewrites, kept so a turn that gives up can put the record back. */
export interface CompactableSnapshot {
  messages: Message[];
  pinnedIndices: Set<number>;
  preservedSummary: string | null;
}

export interface CompactRecoveryResult {
  /** Token room the next request is assembled with. */
  capacityTokens: number;
  /** Oldest unpinned messages this pass evicted. */
  dropped: number;
}

/**
 * The read-only view the request builder takes, narrowed to the one writer.
 *
 * The cast is the honest part: `ContextStore` publishes its fields as `readonly`, so nothing
 * but the class behind it knows they are assignable. Compaction is that writer, so it is here.
 */
export function asCompactable(store: ContextStore): CompactableStore {
  return store as unknown as CompactableStore;
}

export function snapshotCompactable(store: CompactableStore): CompactableSnapshot {
  return {
    messages: [...store.messages],
    pinnedIndices: new Set(store.pinnedIndices),
    preservedSummary: store.preservedSummary,
  };
}

export function restoreCompactable(store: CompactableStore, snapshot: CompactableSnapshot): void {
  store.messages = snapshot.messages;
  store.pinnedIndices = snapshot.pinnedIndices;
  store.preservedSummary = snapshot.preservedSummary;
}

/**
 * One reactive compaction pass for a context-full retry.
 *
 * The live turn stays whole: its tool exchanges are not evicted, because dropping them mid-turn
 * orphans tool results and invites the model to re-run completed work. Older turns share the room
 * the given budget leaves. Surviving pins are remapped onto the kept messages and the trimming
 * note rides on as `preservedSummary`, so the next request still mentions the omission.
 */
export function compactForRecovery(
  store: CompactableStore,
  capacityTokens: number,
): CompactRecoveryResult {
  const budget = Math.max(0, Math.floor(capacityTokens));
  const messages = store.messages;
  const step = liveTurnStart(store);
  const pinned = pinnedFrom(store.pinnedIndices, step, messages.length);
  const result = compact(messages, pinned, budget);
  const positions = new Map<Message, number>();
  result.messages.forEach((m, i) => positions.set(m, i));
  const kept = new Set<number>();
  for (const i of store.pinnedIndices) {
    const at = positions.get(messages[i]);
    if (at !== undefined) kept.add(at);
  }
  store.messages = result.messages;
  store.pinnedIndices = kept;
  if (result.note) {
    store.preservedSummary = [store.preservedSummary, result.note].filter(Boolean).join('\n\n');
  }
  return { capacityTokens: budget, dropped: result.dropped };
}

interface CompactResult {
  messages: Message[];
  /** Oldest unpinned messages evicted. */
  dropped: number;
  /** Library strategies that ran. */
  levels: string[];
  /** Line describing what was evicted; never placed in `messages`. */
  note: string | null;
}

/** The one line that stands in for evicted messages. */
export function trimmedNote(count: number): string {
  return `[Earlier conversation trimmed: ${count} message(s) omitted]`;
}

/** How many messages a trimmed note says were omitted; 0 for anything else. */
export function trimmedCount(note: string | null | undefined): number {
  return Number(/^\[Earlier conversation trimmed: (\d+) message\(s\) omitted\]$/.exec(String(note ?? ''))?.[1] ?? 0);
}

/** Library compaction (clear old tool output, then evict the oldest); pinned messages survive in place. */
export function compact(messages: Message[], pinned: Set<number>, maxTokens: number): CompactResult {
  const ctx = { maxTokens, estimate: messageTokens as unknown as (m: ModelMessage) => number };
  let rest = messages.filter((_, i) => !pinned.has(i)) as unknown as ModelMessage[];
  let dropped = 0;
  const levels: string[] = [];
  const run = (level: string, strategy: CompactionStrategy, skip = 0) => {
    if (sumTokens(rest as unknown as Message[]) <= maxTokens) return;
    const out = strategy(rest, ctx) as ModelMessage[] | null;
    if (!out) return;
    rest = out.slice(skip);
    levels.push(level);
  };
  run('clear-tools', clearToolResults());
  run('evict', evictOldest({ marker: (n) => String((dropped = n)) }), 1);
  let j = -dropped;
  const kept = messages.flatMap((m, i) => (pinned.has(i) ? [m] : j++ < 0 ? [] : [rest[j - 1] as unknown as Message]));
  const start = kept.findIndex((m) => m.role !== ROLE.TOOL);
  return {
    messages: start < 0 ? [] : kept.slice(start),
    dropped,
    levels,
    note: dropped ? trimmedNote(dropped) : null,
  };
}

interface BuildModelRequestParams {
  systemMessages?: Message[];
  store: ContextStore;
  tools?: ToolSchema[];
  /** What the backend can drive; `contextWindow` is the driven num_ctx. */
  modelLimits?: { contextWindow?: number; maxOutputTokens?: number };
  /** Cap from turn-level recovery: a context retry asks for less room. */
  capacityTokens?: number;
  state?: WorkspaceState;
  textMode?: boolean;
  core?: boolean;
  readOnly?: boolean;
  /** Tools the turn never gets: left out of the text-mode catalog as they are out of the tool list. */
  exclude?: readonly string[];
  /** Tools the turn gets on top of its profile: listed in the text-mode catalog as they are in the tool list. */
  include?: readonly string[];
  includeWorkspaceSnapshot?: boolean;
  /** For the structured `[context]` log. */
  meta?: { model?: string; provider?: string };
}

/**
 * The workspace as reference material, and what happened in it since the model last looked. Background processes that
 * ended are news, not reference: under the "for reference only" wrapper a model passed over its own build finishing.
 */
async function workspaceSnapshot(state: WorkspaceState): Promise<{ reference: string; news: string }> {
  try {
    const reference = [await describeProject(state), describeSession(state, { exits: false })].filter(Boolean).join('\n\n');
    const news = describeExitsForModel(state.background?.pending() ?? []).join('\n');
    // The ended background processes are now in front of the model; the turn's end settles them.
    state.background?.markShown();
    return { reference, news };
  } catch (err) {
    logger.debug(`[context] workspace snapshot omitted: ${(err as Error)?.message ?? err}`);
    return { reference: '', news: '' };
  }
}

export async function buildModelRequest({
  systemMessages = [],
  store,
  tools = [],
  modelLimits = {},
  capacityTokens,
  state,
  textMode = false,
  core = false,
  readOnly = false,
  exclude = [],
  include = [],
  includeWorkspaceSnapshot = true,
  meta,
}: BuildModelRequestParams): Promise<PreparedContext> {
  const system = textMode
    ? [...systemMessages, { role: ROLE.SYSTEM, content: textModeInstructions({ core, readOnly, include, exclude }) }]
    : systemMessages;
  const snapshot = includeWorkspaceSnapshot && state ? await workspaceSnapshot(state) : { reference: '', news: '' };
  const trailing = snapshot.reference;
  const news = snapshot.news;
  const reserve = Math.max(0, Math.floor(Number(modelLimits.maxOutputTokens) || 0));
  const promptWindow = Math.max(0, (Number(modelLimits.contextWindow) || 0) - reserve);

  const systemTokens = sumTokens(system);
  const toolTokens = tools.length ? estimateTokens(JSON.stringify(tools)) : 0;
  const trailingTokens = estimateTokens(trailing) + estimateTokens(news);
  const fixed = systemTokens + toolTokens + trailingTokens + estimateTokens(store.preservedSummary ?? '');
  // The current turn stays whole (compacting it evicts reads the model then re-runs in a loop); older turns share what the session budget leaves. Only the window or a retry cap trims the current turn.
  const from = store.messages.findLastIndex((m) => isTurnRequest(m, store.ephemeralIds));
  const history = store.messages.map((m, i) => (i < from ? settledMessage(m) : m));
  const activeTokens = from < 0 ? 0 : sumTokens(history.slice(from));
  const room = Math.max(0, Math.floor(Math.min(...[promptWindow, capacityTokens ?? 0].filter((c) => c > 0).map((c) => c - fixed))));
  // Unset in config, older turns get half the room the window leaves, up to DEFAULT_HISTORY_TOKENS.
  const target = store.budgetTokens ?? (Number.isFinite(room) ? Math.min(DEFAULT_HISTORY_TOKENS, Math.floor(room * HISTORY_SHARE)) : UNKNOWN_WINDOW_HISTORY);
  const historyRoom = Math.min(Math.max(target, activeTokens), room);
  const keepActive = from >= 0 && activeTokens <= room;
  const pinned = keepActive ? pinnedFrom(store.pinnedIndices, from, history.length) : store.pinnedIndices;
  const pruned = compact(history, pinned, keepActive ? historyRoom - activeTokens : historyRoom);
  const kept = pruned.messages;

  // Summary and workspace snapshot ride inside the request, ahead of the person's words: as separate user messages small models answered them instead.
  const at = kept.findLastIndex((m) => isTurnRequest(m, store.ephemeralIds));
  const context = [store.preservedSummary, pruned.note, trailing].filter(Boolean).join('\n\n');
  // What just happened goes after the reference block, right before the person's words.
  const head = [context ? `${CONTEXT_OPEN}\n${context}\n${CONTEXT_CLOSE}` : '', news].filter(Boolean).join('\n\n');
  const request = at >= 0 && head ? { ...kept[at], content: `${head}\n\n${kept[at].content}` } : kept[at];
  // The request keeps its place: moved after this turn's tool results, it read as asked again and the model redid the work.
  const conversation = at >= 0 ? kept.map((m, i) => (i === at ? request : m)) : [...kept, ...(context || news ? [{ role: ROLE.USER, content: [context, news].filter(Boolean).join('\n\n') }] : [])];
  const messages = [...system, ...conversation].map((m) => Object.freeze({ ...m }));

  const inputTokens = sumTokens(messages) + toolTokens;
  const requestTokens = at >= 0 ? messageTokens(kept[at]) : 0;
  const promptBudget = fixed + historyRoom;
  const contextLimit = (promptWindow || promptBudget) + reserve;
  const overflow = promptWindow > 0 ? Math.max(0, inputTokens - promptWindow) : 0;
  const budget: ContextBudget = {
    contextLimit,
    outputReserve: reserve,
    systemTokens,
    toolSchemaTokens: toolTokens,
    requestTokens,
    historyTokens: sumTokens(kept) - requestTokens,
    trailingTokens,
    inputTokens,
    totalReserved: inputTokens + reserve,
    utilization: contextLimit > 0 ? inputTokens / contextLimit : 0,
    overflow,
  };
  // How much history wanted to go against the room it had: what tells the person it is about to be trimmed.
  store.lastBudget = { ...budget, promptBudget, levels: pruned.levels, dropped: pruned.dropped, historyNeeded: sumTokens(history), historyRoom };

  if (logger.enabled('debug')) {
    logger.debug(
      `[context] model=${meta?.model ?? '?'} provider=${meta?.provider ?? '?'} limit=${contextLimit} budget=${promptBudget} ` +
        `input=${inputTokens} system=${systemTokens} tools=${toolTokens} history=${budget.historyTokens} request=${requestTokens} ` +
        `trailing=${trailingTokens} output_reserve=${reserve} utilization=${budget.utilization.toFixed(2)} ` +
        `compacted=[${pruned.levels.join(',')}] dropped=${pruned.dropped} overflow=${overflow} ${overflow > 0 ? '✗' : '✓'}`
    );
  }
  if (logger.enabled('trace')) {
    const cal = tokenCalibration();
    logger.traceBlock('prompt.assembly', [
      cal
        ? `estimate at ${cal.charsPerToken.toFixed(2)} chars/token, calibrated from ${cal.samples} real call(s) on ${cal.model}`
        : `estimate at ${charsPerToken().toFixed(2)} chars/token (cold start — no real usage seen yet)`,
      ...messages.map((m, i) => `  [${i}] ${m.role} ~${messageTokens(m)} tok: ${String(m.content ?? '').slice(0, 200)}`),
    ].join('\n'));
  }

  return { messages, tools, budget, dropped: pruned.dropped };
}
