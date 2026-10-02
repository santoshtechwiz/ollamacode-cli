import { normalizeToolCall } from '../../core/ids';

interface ToolCallSlot {
  id?: string;
  name: string;
  argsText: string;
  argsObj: Record<string, unknown> | null;
}

export class ToolCallAccumulator {
  slots: Map<string | number, ToolCallSlot>;
  order: (string | number)[];

  constructor() {
    this.slots = new Map();
    this.order = [];
  }

  push(frag: { index?: number; id?: string; function?: { name?: string; arguments?: unknown; }; }, fallbackIndex: number = 0) {
    const key = frag?.index ?? frag?.id ?? fallbackIndex;

    let slot = this.slots.get(key);
    if (!slot) {
      slot = { id: frag?.id, name: '', argsText: '', argsObj: null };
      this.slots.set(key, slot);
      this.order.push(key);
    }
    if (frag?.id && !slot.id) slot.id = frag.id;

    const name = frag?.function?.name;
    if (typeof name === 'string' && name.length > 0) {
      slot.name = mergeName(slot.name, name);
    }

    const args = frag?.function?.arguments;
    if (typeof args === 'string') {
      slot.argsText += args;
    } else if (args && typeof args === 'object') {
      slot.argsObj = deepMerge(slot.argsObj ?? {}, (args as Record<string, unknown>));
    }
  }

  get isEmpty(): boolean {
    return this.slots.size === 0;
  }

  finish(): import('../../types.ts').ToolCall[] {
    return this.order.map((key) => {
      const slot = this.slots.get(key)!;
      const args = slot.argsObj !== null ? slot.argsObj : slot.argsText;
      return normalizeToolCall({
        id: slot.id,
        function: { name: slot.name, arguments: args },
      });
    });
  }
}

function mergeName(prev: string, next: string): string {
  if (!prev) return next;
  if (prev === next) return prev; // provider repeats the full name each delta
  if (prev.startsWith(next)) return prev; // stale prefix repeat
  if (next.startsWith(prev)) return next; // provider resends a growing prefix
  return prev + next; // genuine continuation
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  if (!a || typeof a !== 'object') return b ?? {};
  if (!b || typeof b !== 'object') return a ?? {};
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const bv = b[k];
    const av = out[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && av && typeof av === 'object' && !Array.isArray(av)) {
      out[k] = deepMerge(
 (av as Record<string, unknown>),
 (bv as Record<string, unknown>)
      );
    } else {
      out[k] = bv;
    }
  }
  return out;
}

