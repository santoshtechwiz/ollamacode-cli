import type { ToolDef } from '../../types';

/** Case-, dash- and underscore-insensitive key a tool name is matched under, so `read_file`, `read-file` and `readfile` are the same call to the model. */
export function normNameKey(key: string): string {
  return String(key ?? '').toLowerCase().replace(/[-_\s]/g, '');
}

/** The one place a tool becomes callable. */
export class ToolRegistry {
  /** All registered defs in registration order. Read as a live array; do not mutate. */
  readonly defs: ToolDef[] = [];
  /** Canonical tool name → def. Read as a live record; do not mutate. */
  readonly byName: Record<string, ToolDef> = {};
  /** `normNameKey(name)` → canonical name, for models that mistype a tool. */
  readonly names = new Map<string, string>();

  private readonly dynamic = new Set<string>();
  private readonly deferred = new Set<string>();

  register(def: ToolDef): void {
    this.defs.push(def);
    this.byName[def.name] = def;
    this.names.set(normNameKey(def.name), def.name);
    // A tool's own aliases resolve like its name. An alias only fills a free key; a real name set
    // above always wins, including one registered after the alias.
    for (const alias of def.aliases ?? []) {
      const key = normNameKey(alias);
      if (!this.names.has(key)) this.names.set(key, def.name);
    }
  }

  get(name: string): ToolDef | undefined {
    return this.byName[name];
  }

  /** Look a name up the way a model writes it — exact, alias, then normalized — so discovery and execution agree. */
  find(name: string): ToolDef | undefined {
    const raw = String(name ?? '').trim();
    return this.byName[raw] ?? this.byName[this.names.get(normNameKey(raw)) ?? ''];
  }

  has(name: string): boolean {
    return Boolean(this.byName[name]);
  }

  /** Whether a tool arrived through `registerDynamic` rather than the static list. */
  isDynamic(name: string): boolean {
    return this.dynamic.has(name);
  }

  /** Register a tool that arrived after the static list. False when the name is taken. */
  registerDynamic(def: ToolDef, { deferred = false }: { deferred?: boolean } = {}): boolean {
    if (this.byName[def.name]) return false;
    this.register(def);
    this.dynamic.add(def.name);
    if (deferred) this.deferred.add(def.name);
    return true;
  }

  /** Whether the tool's schema goes on the wire; a deferred tool stays callable but unadvertised until loaded. */
  isOffered(name: string): boolean {
    return !this.deferred.has(name);
  }

  /** Start advertising deferred tools. Returns the names that were actually deferred. */
  load(names: Iterable<string>): string[] {
    return [...names].filter((name) => this.deferred.delete(name));
  }

  namesList(): string[] {
    return this.defs.map((d) => d.name);
  }
}

/** The registry every built-in tool registers into, in one determinable order. */
export const defaultRegistry = new ToolRegistry();