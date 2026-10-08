import { TOOL_META, NORMALIZED_NAMES } from '../../tool/index';
import { normNameKey } from '../../tool/execution/registry';

export { normNameKey };

/** The registered name a model meant: exact, or matched loosely against every tool's name and its own aliases. */
export function resolveToolName(name: string): string {
  const raw = String(name ?? '');
  if (TOOL_META[raw]) return raw;
  return NORMALIZED_NAMES.get(normNameKey(raw)) ?? raw;
}
