import type { Message, ToolCall } from '../types';
import { ROLE } from '../protocol';
import { agentConfig } from '../core/config';
import { logger } from '../core/logger';
import { newId } from '../core/ids';
import { isContinueInput } from '../agent/intent';
import { messageTokens } from './tokens';
import type { ContextBudget } from './contracts';

const ROLE_LABEL_ECHO = /^(?:assistant|user)\r?\n+(?:\r?\n+)?/;


function stripRoleHeaderEcho(content: string): string {
  let out = String(content ?? '');
  while (ROLE_LABEL_ECHO.test(out)) out = out.replace(ROLE_LABEL_ECHO, '');
  return out;
}


export class ContextStore {
  messages: Message[];
  budgetTokens?: number;
  pinnedIndices: Set<number>;
  /** Ids of mid-turn scaffolding, removed by dropEphemeral() when the turn ends. */
  ephemeralIds: Set<string>;
  /** The summary saved with a resumed record: the past survives across processes even when the record only kept the recent window. */
  preservedSummary: string | null;
  /** Accounting of the last assembled request, for `/context`. */
  lastBudget: (ContextBudget & { promptBudget: number; levels: string[]; dropped: number; }) | null = null;
  /** Singleton harness messages (e.g. execution progress) keyed by slot; a new one replaces the old. */
  private slots = new Map<string, string>();

  constructor({ messages = [], budgetTokens, preservedSummary = null }: { messages?: Message[]; budgetTokens?: number; preservedSummary?: string | null; } = {}) {
    this.messages = [...messages];
    this.budgetTokens = budgetTokens;
    this.pinnedIndices = new Set();
    this.ephemeralIds = new Set();
    this.preservedSummary = preservedSummary;
  }

  addUser(content: string, { pinned = false, ephemeral = false, slot }: { pinned?: boolean; ephemeral?: boolean; slot?: string; } = {}) {
    if (slot) this.removeSlot(slot);
    const message = { id: newId(), role: ROLE.USER, content };
    if (slot) this.slots.set(slot, message.id);
    this.messages.push(message);
    const idx = this.messages.length - 1;
    if (pinned) this.pinnedIndices.add(idx);
    if (ephemeral) this.ephemeralIds.add(message.id);
    return this;
  }


  removeSlot(slot: string) {
    const id = this.slots.get(slot);
    this.slots.delete(slot);
    const at = id ? this.messages.findIndex((m) => m.id === id) : -1;
    if (at < 0) return;
    this.messages.splice(at, 1);
    const pins = new Set<number>();
    for (const i of this.pinnedIndices) if (i !== at) pins.add(i > at ? i - 1 : i);
    this.pinnedIndices = pins;
  }

  /** A new turn: only the pins it adds itself stay compaction-proof. */
  releasePins() {
    this.pinnedIndices.clear();
    return this;
  }

  dropEphemeral(): number {
    if (this.ephemeralIds.size === 0) return 0;
    const kept: Message[] = [];
    const pinned = new Set<number>();
    for (let i = 0; i < this.messages.length; i++) {
      const message = this.messages[i];
      if (message.id && this.ephemeralIds.has(message.id)) continue;
      if (this.pinnedIndices.has(i)) pinned.add(kept.length);
      kept.push(message);
    }
    const removed = this.messages.length - kept.length;
    this.messages = kept;
    this.pinnedIndices = pinned;
    this.ephemeralIds.clear();
    return removed;
  }

  addAssistant(content: string, toolCalls?: ToolCall[], { pinned = false }: { pinned?: boolean; } = {}): number {
    const message: Message = { id: newId(), role: ROLE.ASSISTANT, content: stripRoleHeaderEcho(content ?? '') };
    if (toolCalls?.length) message.tool_calls = toolCalls;
    this.messages.push(message);
    const idx = this.messages.length - 1;
    if (pinned) this.pinnedIndices.add(idx);
    return idx;
  }

  addToolResult(call: ToolCall, content: string) {
    this.messages.push({
      id: newId(),
      role: ROLE.TOOL,
      content,
      tool_call_id: call.id,
      name: call.function.name,
    });
    return this;
  }

  get tokenCount(): number {
    return this.messages.reduce((sum, m) => sum + messageTokens(m), 0);
  }

  serialize({ maxToolChars = 4000 }: { maxToolChars?: number; } = {}): Message[] {
  
    this.dropEphemeral();
  
    const stored: Message[] = [];
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m.role === ROLE.USER && typeof m.content === 'string' && isContinueInput(m.content)) continue;
      stored.push(m);
    }
    while (stored.length > 0 && stored[0].role === ROLE.TOOL) stored.shift();

    return stored.map((m) =>
      m.role === ROLE.TOOL && (m.content?.length ?? 0) > maxToolChars
        ? { ...m, content: `${m.content.slice(0, maxToolChars)}\n…[truncated]` }
        : m
    );
  }

  clear() {
    this.messages = [];
    this.pinnedIndices.clear();
    this.ephemeralIds.clear();
    this.preservedSummary = null;
    this.lastBudget = null;
    this.slots.clear();
    return this;
  }

  static restore(raw: unknown, budgetTokens?: number, preservedSummary?: string | null): ContextStore {
    const input: unknown[] = Array.isArray(raw) ? raw : [];
    const messages: Message[] = [];
    const seen = new Set<string>();

    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const m = (item as Message);
      if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) continue;
      if (typeof m.content !== 'string') continue;
      // Control signals from older records never re-enter the working context.
      if (m.role === ROLE.USER && isContinueInput(m.content)) continue;
      if (typeof m.id === 'string' && m.id) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
      }
      messages.push(m);
    }

    const clean: Message[] = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === ROLE.ASSISTANT && m.tool_calls?.length) {
        const answered = new Set<string>();
        for (let j = i + 1; j < messages.length && messages[j].role === ROLE.TOOL; j++) {
          if (messages[j].tool_call_id) answered.add(messages[j].tool_call_id as string);
        }
        const complete = m.tool_calls.every((c) => answered.has(c.id));
        if (!complete) {
          logger.debug('history: dropping an assistant turn with unanswered tool calls');
          if (m.content?.trim()) clean.push({ role: ROLE.ASSISTANT, content: stripRoleHeaderEcho(m.content) });
          while (i + 1 < messages.length && messages[i + 1].role === ROLE.TOOL) i += 1;
          continue;
        }
      }
      if (m.role === ROLE.TOOL && !m.tool_call_id) continue;
      clean.push(m.role === ROLE.ASSISTANT ? { ...m, content: stripRoleHeaderEcho(m.content) } : m);
    }

    return new ContextStore({ messages: clean, budgetTokens, preservedSummary: preservedSummary ?? null });
  }
}

export function createContextStore(messages: Message[] = []): ContextStore {
  return new ContextStore({ messages, budgetTokens: agentConfig().contextBudget });
}


/** Resume the saved record whole: it is already bounded on save, and each request trims to the live window. */
export function restoreContextStore(savedMessages: unknown, preservedSummary?: string | null): ContextStore {
  return ContextStore.restore(savedMessages, agentConfig().contextBudget, preservedSummary);
}
