import { defaultRegistry } from '../execution/registry';
import {
  targetPathArg as policyTargetPathArg,
  fileTargetArg as policyFileTargetArg,
  isReadOnlyCommand,
  isTestCommand,
  escapesWorkspace,
  type CommandClassify,
} from '../policy/index';

const policyCmd: CommandClassify = { isReadOnlyCommand, isTestCommand, escapesWorkspace };

/** Live view of registered tools; read at call time so late registrations are honored. */
function toolMeta() {
  return defaultRegistry.byName;
}

/** The single argument that identifies the target being changed, per the live tool schema. */
export function targetPathArg(toolName: string): string | null {
  return policyTargetPathArg(toolName, toolMeta());
}

/** The path argument, but only for calls that classify as mutating. */
export function fileTargetArg(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  return policyFileTargetArg(toolName, args, {
    meta: toolMeta(),
    cmd: policyCmd,
  });
}
