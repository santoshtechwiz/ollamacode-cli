import { defaultRegistry } from '../execution/registry';
import {
  targetPathArg as policyTargetPathArg,
  fileTargetArg as policyFileTargetArg,
  isReadOnlyCommand,
  isTestCommand,
  escapesWorkspace,
  type CommandClassify,
} from '../policy/index';
import { classifyTool } from '../policy/mutation-policy';

const policyCmd: CommandClassify = { isReadOnlyCommand, isTestCommand, escapesWorkspace };

/** Live view of registered tools; read at call time so late registrations are honored. */
function toolMeta() {
  return defaultRegistry.byName;
}

/** The single argument that identifies the target being changed, per the live tool schema. */
export function targetPathArg(toolName: string): string | null {
  return policyTargetPathArg(toolName, toolMeta());
}

/** Whether a call needs approval, classified with the live tool schema and the shell command classifier. */
export function classifyCall(toolName: string, args: Record<string, unknown>, where: { cwd?: string; root?: string; def?: any } = {}): 'read-only' | 'mutating' {
  // The caller's own definition wins: a runtime with its own registry knows tools the default one does not.
  const meta = where.def ? { ...toolMeta(), [toolName]: where.def } : toolMeta();
  return classifyTool(toolName, args, { cwd: where.cwd, root: where.root, meta, cmd: policyCmd });
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
