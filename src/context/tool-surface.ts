import { TOOLS, isDynamicTool, isOfferedTool } from '../tool/index';
import { TOOL_NAME } from '../protocol';
import type { ToolProfileName } from '../types';

// Membership lives on each tool definition (its profiles); these are read from it once, in registration order.
const inProfile = (profile: ToolProfileName): string[] => TOOLS.filter((t) => t.profiles?.includes(profile)).map((t) => t.name);

const CORE_TOOLS = inProfile('core');

const PLANNING_TOOLS = inProfile('planning');

/** Schemas on every request: the cheap tools a turn needs before it knows what else it needs. */
export const ALWAYS_TOOLS: readonly string[] = Object.freeze(inProfile('always'));

export interface ToolProfile {
  compact?: boolean;
  core?: boolean;
  native?: boolean;
  readOnly?: boolean;
  /** Overrides which tools are advertised up front instead of through discovery. */
  always?: readonly string[];
  /** Tools this turn never gets, whatever else the profile allows (a subagent's, or one with no delegate). */
  exclude?: readonly string[];
}

/** The tools a profile makes available, in registration order; the one place a profile becomes a list. */
export function selectToolDefs({ core = false, readOnly = false, exclude = [] }: ToolProfile = {}): import('../types.ts').ToolDef[] {
  const selected = readOnly
    ? TOOLS.filter((t) => PLANNING_TOOLS.includes(t.name))
    : core
      ? TOOLS.filter((t) => CORE_TOOLS.includes(t.name) || isDynamicTool(t.name))
      : TOOLS;

  return selected.filter((t) => isOfferedTool(t.name) && t.name !== TOOL_NAME.LOAD_TOOLS && !exclude.includes(t.name));
}

/** The always-tools the profile allows; a profile that excludes one simply does not get it. */
export function selectAlwaysToolDefs(profile: ToolProfile = {}): import('../types.ts').ToolDef[] {
  const always = profile.always ?? ALWAYS_TOOLS;
  return selectToolDefs(profile).filter((def) => always.includes(def.name));
}

export function coreToolNames() {
  return [...CORE_TOOLS];
}

export function readOnlyToolNames() {
  return [...PLANNING_TOOLS, 'ask_user'];
}

