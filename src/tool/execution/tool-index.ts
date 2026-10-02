/** The lightweight view of the registry: what exists, and what it is for — nothing more. */

import type { ToolCategory, ToolDef } from '../../types';
import type { ToolRegistry } from './registry';

const MAX_BRIEF_CHARS = 120;

/** One line of the index. Carries no parameters, so it costs a fraction of a full schema. */
export interface ToolIndexEntry {
  name: string;
  brief: string;
  category: ToolCategory;
}

export interface ToolIndex {
  /** Registration order, so the rendered index is byte-stable across requests. */
  entries: ToolIndexEntry[];
  byCategory: Map<ToolCategory, ToolIndexEntry[]>;
}

function truncate(text: string): string {
  return text.length <= MAX_BRIEF_CHARS ? text : `${text.slice(0, MAX_BRIEF_CHARS - 1).trimEnd()}…`;
}

/** The tool's own one-liner when it has one, else its description's first sentence. */
export function briefOf(def: ToolDef): string {
  const brief = String(def.brief ?? '').trim();
  if (brief) return truncate(brief);
  const description = String(def.description ?? '').trim();
  const sentence = description.match(/^[^.]+\./);
  return truncate((sentence ? sentence[0] : description).trim());
}

/** Group entries into the lookup maps an index is read through. */
export function buildIndexOf(entries: ToolIndexEntry[]): ToolIndex {
  const byCategory = new Map<ToolCategory, ToolIndexEntry[]>();

  for (const entry of entries) {
    const bucket = byCategory.get(entry.category);
    if (bucket) bucket.push(entry);
    else byCategory.set(entry.category, [entry]);
  }

  return { entries, byCategory };
}

/** Build the index from the registry's live defs; build it per turn so late-registered tools appear. */
export function buildToolIndex(registry: ToolRegistry): ToolIndex {
  return buildIndexOf(
    registry.defs.map((def) => ({
      name: def.name,
      brief: briefOf(def),
      category: def.category ?? 'agent',
    })),
  );
}

/** The index as the model reads it: one line per tool, grouped by capability. */
export function formatToolIndex(index: ToolIndex): string {
  return [...index.byCategory.entries()]
    .map(([category, group]) => `${category}:\n${group.map((e) => `  ${e.name} — ${e.brief}`).join('\n')}`)
    .join('\n');
}
