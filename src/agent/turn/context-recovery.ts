// Assembling the model request, and the bounded recovery when it does not fit the context window.

import { ROLE, AGENT_STATUS } from '../../protocol';
import type { ContextStore, PreparedContext } from '../../context/contracts';
import type { Message, ToolCall, ToolSchema } from '../../types';
import {
  buildModelRequest,
  compactForRecovery,
  asCompactable,
  snapshotCompactable,
  restoreCompactable,
  liveTurnStart,
} from '../../context/builder';
import type { CompactableSnapshot, CompactRecoveryResult } from '../../context/builder';
import { logger } from '../../core/logger';
import { renderedAsFailure } from './tool-calls';
import type { TurnState } from './turn-state';

/** At most this many history compactions per turn before a full context is terminal. */
const MAX_CONTEXT_COMPACTIONS = 3;
/** Each compaction shrinks the next request's token room to this share of the last. */
const COMPACTION_SHRINK = 0.7;
/** How many completed actions the note names before it counts the rest. */
const COMPLETED_NOTE_LIMIT = 12;
/** An identifying arg is a path or a flag; a file body or a shell script is neither. */
const COMPLETED_NOTE_ARG_CHARS = 60;

/** An arg value short and flat enough to name a call without restating its payload. */
function namesTheCall(value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (typeof value !== 'string') return false;
  return value.length > 0 && value.length <= COMPLETED_NOTE_ARG_CHARS;
}

/**
 * `read_file(path="a.ts")` — enough to tell two calls apart, and no more.
 *
 * `write_file` carries the whole new file and `exec_shell` the whole command line; either one
 * inlined here would cost the recovery more room than the note is worth.
 */
function actionTag(name: string, args: Record<string, unknown> | undefined): string {
  const named = Object.entries(args ?? {}).filter(([, value]) => namesTheCall(value));
  if (!named.length) return name;
  return `${name}(${named.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(', ')})`;
}

/**
 * The calls that already settled, as short tags.
 *
 * A tool result message carries neither the arguments nor the outcome of its call: the
 * arguments live on the assistant message that asked, and the outcome only in the rendered
 * result text. Both are read from where they were actually written, because a note that
 * names a call that failed is worse than no note at all.
 */
function completedActionTags(history: ContextStore, turnState: TurnState): string[] {
  const tags: string[] = [];
  const asked = new Map<string, ToolCall>();

  for (const message of history.messages) {
    if (message.role === ROLE.ASSISTANT) {
      for (const call of message.tool_calls ?? []) asked.set(call.id, call);
      continue;
    }
    if (message.role !== ROLE.TOOL) continue;
    const call = message.tool_call_id ? asked.get(message.tool_call_id) : undefined;
    // A result with no call behind it names nothing, and a failed one is work still to do.
    if (!call || renderedAsFailure(message.content)) continue;
    tags.push(actionTag(call.function.name, call.function.arguments));
  }

  for (const record of turnState.toolCalls) {
    if (record.isRepeat || !record.result?.ok) continue;
    tags.push(actionTag(record.name, record.args));
  }

  return [...new Set(tags)];
}

function completedActionsNote(tags: string[]): string | null {
  if (!tags.length) return null;
  const shown = tags.slice(0, COMPLETED_NOTE_LIMIT);
  const rest = tags.length - shown.length;
  const list = rest ? `${shown.join(', ')} (and ${rest} more)` : shown.join(', ');
  return `Already completed: ${list}. Do not re-request these.`;
}

export interface ContextRecoveryOptions {
  history: ContextStore;
  /** The completed-actions note is added to this list in place. */
  systemMessages: Message[];
  /** The tools offered on the next request; read at every assembly because discovery grows them. */
  tools: () => ToolSchema[];
  config: any;
  workspaceState: any;
  textMode: boolean;
  core?: boolean;
  readOnly: boolean;
  meta: { model: string; provider?: string };
  turnState: TurnState;
  compactor: typeof compactForRecovery;
  onStatus?: (status: string) => void;
}

export interface ContextRecovery {
  /** The token room the last compaction left, for any later request in this turn. */
  readonly capacityTokens: number | undefined;
  /** The next request, compacted until it fits the window. */
  nextRequest(): Promise<PreparedContext>;
  /** The backend rejected the request as too long: compact, and rebuild it until it fits. */
  afterContextFull(): Promise<PreparedContext>;
}

/**
 * One recovery state per turn. Turn state is never touched — completed tool results stay in
 * `turnState.toolCalls`, so a repeated request reuses its earlier result instead of running the tool again.
 */
export function createContextRecovery(options: ContextRecoveryOptions): ContextRecovery {
  const { history, systemMessages, config, compactor, turnState } = options;
  const store = asCompactable(history);
  let capacityTokens: number | undefined;
  let compactions = 0;
  let snapshot: CompactableSnapshot | null = null;
  let completedNote: Message | null = null;

  const assemble = (): Promise<PreparedContext> =>
    buildModelRequest({
      systemMessages,
      store: history,
      tools: options.tools(),
      modelLimits: {
        contextWindow: Number(config.contextWindow) || undefined,
        maxOutputTokens: Number(config.maxTokens) || undefined,
      },
      capacityTokens,
      state: options.workspaceState,
      textMode: options.textMode,
      core: options.core,
      readOnly: options.readOnly,
      includeWorkspaceSnapshot: true,
      meta: options.meta,
    });

  /**
   * The passes already rewrote the record; a turn that ends in an error must not hand back a session that lost history for nothing.
   * Compaction only ever rewrites the history before the live turn, so that is all a restore puts back: the older part comes
   * from the snapshot, and the live turn (its request and every exchange since, work that really happened) stays as it is.
   */
  const restore = (): void => {
    if (!snapshot) return;
    const olderEnd = liveTurnStart({ messages: snapshot.messages, ephemeralIds: store.ephemeralIds });
    const liveFrom = liveTurnStart(store);
    const live = store.messages.slice(liveFrom);
    const livePins = [...store.pinnedIndices].filter((i) => i >= liveFrom).map((i) => olderEnd + (i - liveFrom));
    const olderPins = [...snapshot.pinnedIndices].filter((i) => i < olderEnd);
    restoreCompactable(store, snapshot);
    store.messages = [...snapshot.messages.slice(0, olderEnd), ...live];
    store.pinnedIndices = new Set([...olderPins, ...livePins]);
  };

  /** One bounded step: compact the history, shrink the assembly room, and rebuild the request. */
  const compactOnce = async (why: string): Promise<PreparedContext> => {
    if (compactions >= MAX_CONTEXT_COMPACTIONS) {
      restore();
      const last = history.lastBudget;
      logger.debug('context still over the window after compaction', {
        compactions,
        inputTokens: last?.inputTokens,
        contextLimit: last?.contextLimit,
      });
      throw new Error(
        'This conversation has grown too long to continue. Start a new one with /clear, or pick up from an earlier point.',
      );
    }
    snapshot ??= snapshotCompactable(store);
    let compacted: CompactRecoveryResult;
    try {
      const window = Number(config.contextWindow) || 0;
      const base =
        capacityTokens ??
        (window > 0
          ? window - (Number(config.maxTokens) || 0)
          : Math.max(history.budgetTokens ?? 0, history.tokenCount));
      capacityTokens = Math.floor(base * COMPACTION_SHRINK);
      // Read before the pass, not after: the note exists to keep the knowledge that the pass
      // is about to erase, and this turn's own results survive either way.
      const note = completedActionsNote(completedActionTags(history, turnState));
      compacted = compactor(store, capacityTokens);
      // One note, rewritten in place. A system message appended per pass would grow the very
      // request this recovery is trying to fit, three times over in the worst turn.
      if (note) {
        if (completedNote) {
          completedNote.content = note;
        } else {
          completedNote = { role: ROLE.SYSTEM, content: note };
          systemMessages.push(completedNote);
        }
      }
    } catch (err) {
      restore();
      logger.debug(`context compaction failed (${why})`, { error: (err as Error)?.message ?? String(err) });
      throw new Error('This conversation could not be shortened to fit. Start a new one with /clear to continue.', {
        cause: err,
      });
    }
    compactions += 1;
    logger.debug(
      `context ${why} — compacted history (dropped ${compacted.dropped}, next room ≈${compacted.capacityTokens} tok, store ≈${history.tokenCount} tok)`,
    );
    options.onStatus?.(AGENT_STATUS.MAKING_ROOM);
    return assemble();
  };

  /** The builder assembles the best request it can; when even that spills over the window, compact instead of sending a call the backend is known to reject. */
  const untilItFits = async (request: PreparedContext): Promise<PreparedContext> => {
    let next = request;
    while (next.budget.overflow > 0) next = await compactOnce('saturated');
    return next;
  };

  return {
    get capacityTokens() {
      return capacityTokens;
    },
    nextRequest: async () => untilItFits(await assemble()),
    afterContextFull: async () => untilItFits(await compactOnce('full')),
  };
}
