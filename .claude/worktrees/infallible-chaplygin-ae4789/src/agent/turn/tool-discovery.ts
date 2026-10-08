// Discovery decisions for one call: answer load_tools from the turn's resolver, refuse tools whose schema was never sent.

import { TOOL_ERROR_CODE, TOOL_NAME } from '../../protocol';
import type { ToolCall, ToolResult, ToolSchema } from '../../types';
import { fail } from '../../tool/core/tool-result';
import { answerLoadTools } from '../../tool/core/load-tools.tool';
import { isResolved, type ToolResolver } from '../../tool/execution/tool-resolver';
import { resolveToolName } from '../router/names';

export type DiscoveryDecision =
  | { kind: 'UNVERIFIED'; result: ToolResult }
  | { kind: 'DISCOVERED'; result: ToolResult };

/** The tool names the model could see in the request that produced this reply. */
export function namesOnWire(tools: ToolSchema[]): Set<string> {
  return new Set(tools.map((t) => t.function.name));
}

/** Null when the call goes through the normal decision; otherwise the discovery answer for it. */
export function decideDiscovery(call: ToolCall, resolver: ToolResolver, onWire: ReadonlySet<string>): DiscoveryDecision | null {
  const name = resolveToolName(String(call.function?.name ?? ''));

  if (name === TOOL_NAME.LOAD_TOOLS) {
    return { kind: 'DISCOVERED', result: answerLoadTools(call.function?.arguments, resolver) };
  }
  if (onWire.has(name)) return null;

  // Unknown or out-of-profile names fall through to prepareCall's own refusal.
  const outcome = resolver.load(name);
  if (!isResolved(outcome) || onWire.has(outcome.name)) return null;

  return {
    kind: 'UNVERIFIED',
    result: fail(`${outcome.name} was called before its schema was loaded, so it did not run`, {
      code: TOOL_ERROR_CODE.EINVAL,
      hint: `${outcome.name}'s full schema is in your next request; call it again using the arguments it shows.`,
    }),
  };
}
