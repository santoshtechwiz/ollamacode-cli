// On-demand discovery: names resolve only against the registry, and each loaded schema stays on the wire.

import type { ToolDef, ToolSchema } from '../../types';
import { TOOL_NAME } from '../../protocol';
import { defaultRegistry, type ToolRegistry } from './registry';
import { buildIndexOf, buildToolIndex, formatToolIndex, type ToolIndex } from './tool-index';
import { toToolSchema } from './tool-wire';

export interface ToolResolverOptions {
  registry?: ToolRegistry;
  /** Narrows what is discoverable to the session's tool profile. */
  selectable?: (def: ToolDef) => boolean;
  /** Names advertised with their full schema from the first request, so no round trip is spent. */
  always?: readonly string[];
  compact?: boolean;
}

export interface ResolvedTool {
  name: string;
  schema: ToolSchema;
}

export interface UnresolvedTool {
  name: string;
  reason: string;
}

/** A name either resolved to a registered tool or did not; there is no third case. */
export type LoadOutcome = ResolvedTool | UnresolvedTool;

export function isResolved(outcome: LoadOutcome): outcome is ResolvedTool {
  return 'schema' in outcome;
}

export class ToolResolver {
  readonly index: ToolIndex;
  private readonly registry: ToolRegistry;
  private readonly selectable: ((def: ToolDef) => boolean) | undefined;
  private readonly always: ReadonlySet<string>;
  private readonly compact: boolean;
  /** Canonical name → wire schema, in the order the tools were asked for. */
  private readonly loaded = new Map<string, ToolSchema>();

  constructor({ registry = defaultRegistry, selectable, always = [], compact = false }: ToolResolverOptions = {}) {
    this.registry = registry;
    this.selectable = selectable;
    this.compact = compact;
    this.always = new Set(always);
    this.index = buildToolIndex(registry);
    // Seeded before anything else so they lead the request in a stable order, and so a turn that
    // needs one of them never has to ask for it.
    for (const name of this.always) this.load(name);
  }

  /** Whether a registered tool is reachable this session. */
  isDiscoverable(def: ToolDef): boolean {
    return !this.selectable || this.selectable(def);
  }

  /** The index as the model reads it, so it can name what it wants. */
  describe(): string {
    return formatToolIndex(this.discoverableIndex());
  }

  /** The subset of the index this session may load, minus what is already advertised in full. */
  discoverableIndex(): ToolIndex {
    const selectable = this.selectable;
    return buildIndexOf(
      this.index.entries.filter((entry) => {
        if (this.always.has(entry.name)) return false;
        return !selectable || selectable(this.registry.get(entry.name)!);
      }),
    );
  }

  /** Resolve one name to its wire schema, or to the reason it cannot be loaded. */
  load(name: string): LoadOutcome {
    const asked = String(name ?? '').trim();
    const def = this.registry.find(asked);
    // An unknown name is keyed by what was asked, so a later typo of the same name hits the same
    // miss instead of being re-resolved under a second key.
    const resolved = def?.name ?? asked;

    const cached = this.loaded.get(resolved);
    if (cached) return { name: resolved, schema: cached };

    if (!def) {
      return { name: resolved, reason: `No tool named "${asked}" is registered.` };
    }
    // The discovery call is already on every request; loading it would only say that twice.
    if (resolved === TOOL_NAME.LOAD_TOOLS) {
      return { name: resolved, reason: `${resolved} is already loaded.` };
    }
    if (!this.isDiscoverable(def)) {
      return { name: resolved, reason: `${resolved} is not available in this session.` };
    }

    const schema = toToolSchema(def, { compact: this.compact });
    this.loaded.set(resolved, schema);
    return { name: resolved, schema };
  }

  /** Resolve several names at once, in the order given; a name repeated in one request resolves once. */
  loadAll(names: Iterable<string>): LoadOutcome[] {
    const outcomes: LoadOutcome[] = [];
    const seen = new Set<string>();
    for (const name of names) {
      const outcome = this.load(name);
      if (seen.has(outcome.name)) continue;
      seen.add(outcome.name);
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** Everything loaded, ready to go on the wire. */
  schemas(): ToolSchema[] {
    return [...this.loaded.values()];
  }
}
