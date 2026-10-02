import { CLI_ERROR_CODE } from '../../protocol';
import { TcError } from '../../core/errors';

const REQUIRED = ['name', 'description', 'parameters', 'execute'];

const MAX_BRIEF_CHARS = 180;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze( (value as any)[key]);
    }
  }
  return value;
}

export function defineTool(def: Partial<import('../../types.ts').ToolDef> & Record<string, unknown>): import('../../types.ts').ToolDef {
  const missing = REQUIRED.filter((k) => def[k] === undefined);
  if (missing.length > 0) {
    throw new TcError(`Tool "${def.name ?? '?'}" missing: ${missing.join(', ')}`, {
      code: CLI_ERROR_CODE.ETOOL_INVALID,
    });
  }
  if (typeof def.execute !== 'function') {
    throw new TcError(`Tool "${def.name}" has a non-function execute`, { code: CLI_ERROR_CODE.ETOOL_INVALID });
  }
  if (def.brief !== undefined && String(def.brief).length > MAX_BRIEF_CHARS) {
    throw new TcError(
      `Tool "${def.name}" has a brief description of ${String(def.brief).length} chars (max ${MAX_BRIEF_CHARS})`,
      { code: CLI_ERROR_CODE.ETOOL_INVALID }
    );
  }
  if (!/^[a-z][a-z0-9_]*$/.test(String(def.name))) {
    throw new TcError(
      `Tool name "${def.name}" must be snake_case (models cannot reliably emit other forms)`,
      { code: CLI_ERROR_CODE.ETOOL_INVALID }
    );
  }

  const tool = {
    risky: false,
    label: String(def.name),
    ...def,
  };
  deepFreeze(tool.parameters);
  return deepFreeze( (tool as import('../../types.ts').ToolDef));
}

