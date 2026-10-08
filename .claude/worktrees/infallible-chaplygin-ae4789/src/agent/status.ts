import { defaultRegistry } from '../tool/execution/registry';

/** The tool's own activity label, falling back to its display label so a dynamic tool still reads as work. */
export function activityForTool(toolName: string): string {
  const def = defaultRegistry.find(toolName);
  return def?.activity ?? def?.label ?? String(toolName ?? '').trim();
}
