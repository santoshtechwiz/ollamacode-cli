import { TOOL_ERROR_CODE } from '../../protocol';
import { fail } from '../core/tool-result';
import { resolveToolName } from '../../agent/router/names';
import { parseArgs, normalizeArgs, validate, suggestCall } from '../../agent/router/args';
import type { ToolDef, ToolResult } from '../../types';
import { defaultRegistry, type ToolRegistry } from './registry';

export type PreparedCall =
  // Result on both branches for strictNullChecks narrowing.
  | { ok: true; resolved: string; def: ToolDef; args: Record<string, unknown>; result?: undefined; }
  | { ok: false; resolved: string; def?: ToolDef; args: Record<string, unknown>; result: ToolResult; };

// Pre-approval validation: tool identity, normalized args, arg validity.
export function prepareCall(
  name: string,
  rawArgs: Record<string, unknown> | undefined,
  registry: ToolRegistry = defaultRegistry
): PreparedCall {
  const resolved = resolveToolName(name);
  const def = registry.byName[resolved];
  if (!def) {
    return {
      ok: false,
      resolved,
      args: rawArgs ?? {},
      result: fail(`Unknown tool: ${name}`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: `Available tools: ${registry.defs.map((t) => t.name).join(', ')}`,
      }),
    };
  }

  // Pipeline: parse -> normalize -> validate. A call the tool itself knows will fail is refused by its cannotRun, in the runtime. normalizeArgs re-parses its (already parsed) input idempotently.
  const parsed = parseArgs(def, rawArgs ?? {});
  const args = normalizeArgs(parsed, def);

  const validationError = validate(def, args);
  if (validationError) {
    // A bare "Required: action" leaves the model to guess the value; the schema already knows it.
    const missing = (def.parameters.required ?? []).filter(
      (key) => args[key] === undefined || args[key] === null,
    );
    const named = missing.map((key) => {
      const allowed = def.parameters?.properties?.[key]?.enum;
      return allowed?.length
        ? `${key} (one of: ${allowed.map((value) => JSON.stringify(value)).join(', ')})`
        : key;
    });
    const required =
      validationError.startsWith('Missing') && !validationError.includes('either')
        ? `Required: ${(named.length > 0 ? named : def.parameters.required ?? []).join(', ')}`
        : '';
    // The call it just made, corrected from the schema, says more than the rule it broke; it already names what is missing.
    const hint = suggestCall(def, args) ?? (required || undefined);
    return { ok: false, resolved, def, args, result: fail(validationError, { code: TOOL_ERROR_CODE.EINVAL, hint }) };
  }

  return { ok: true, resolved, def, args };
}
