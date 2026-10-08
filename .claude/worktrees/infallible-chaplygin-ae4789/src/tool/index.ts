import { logger } from '../core/logger';
import { defaultRegistry } from './execution/registry';
import { BUILT_IN_TOOLS } from './common/built-ins';

type ToolDef = import('../types.ts').ToolDef;

const registry = defaultRegistry;

for (const def of BUILT_IN_TOOLS) {
  registry.register(def);
}

/** The tool registry. */
export const TOOLS: ToolDef[] = registry.defs;

/** Name → def. */
export const TOOL_META: Record<string, ToolDef> = registry.byName;

/** Dashless, lowercase name → real name, for models that mistype a tool. */
export const NORMALIZED_NAMES: Map<string, string> = registry.names;

/** Names that arrived from an MCP server or a user plugin rather than from the list above. */
export function isDynamicTool(name: string): boolean {
  return registry.isDynamic(name);
}

/** Whether a tool's schema is sent to the model; deferred MCP tools are not until loaded. */
export function isOfferedTool(name: string): boolean {
  return registry.isOffered(name);
}

/** Add MCP or user-plugin tools, which arrive after the built-ins are in place. */
export function registerDynamicTools(defs: ToolDef[], opts: { deferred?: boolean } = {}) {
  for (const def of defs) {
    if (!registry.registerDynamic(def, opts)) {
      logger.debug(`skipping dynamic tool "${def.name}": name already registered`);
    }
  }
}

// Shared tool logic lives in ./common; re-exported here so every
// consumer has a single entry point: src/tool/index.ts.
export { fileTargetArg } from './common/wired-policy';
