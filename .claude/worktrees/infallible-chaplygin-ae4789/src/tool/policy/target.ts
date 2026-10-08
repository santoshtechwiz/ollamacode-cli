import { pathArgsOf } from '../core/paths';
import { classifyTool, normalizeToolName } from './mutation-policy';
import type { ClassifyOptions, ToolMetaMap } from './mutation-policy';

/** The argument naming the target being changed (never cwd), found via the schema's path args. */
export function targetPathArg(
  toolName: string,
  meta: ToolMetaMap,
): string | null {
  const name = normalizeToolName(toolName);
  const definition = meta[name];

  if (!definition) {
    return null;
  }

  const targets = pathArgsOf(definition).filter(
    (key) => key !== 'cwd',
  );

  return targets.length === 1 ? targets[0] : null;
}

/** Returns the path argument only for mutating tools. */
export function fileTargetArg(
  toolName: string,
  args: Record<string, unknown>,
  opts: ClassifyOptions = {},
): string | null {
  if (classifyTool(toolName, args, opts) !== 'mutating') {
    return null;
  }

  return targetPathArg(toolName, opts.meta ?? {});
}