import path from 'node:path';

import { TOOL_ERROR_CODE } from '../../protocol';
import { ToolError } from './tool-error';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function forCompare(p: string) {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

/** True when `child` resolves inside `parent` (or *is* `parent`). */
export function isInside(parent: string, child: string): boolean {
  const p = forCompare(parent);
  const c = forCompare(child);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function pathArgsOf(def: import('../../types.ts').ToolDef): string[] {
  const props = def?.parameters?.properties ?? {};
  return Object.keys(props).filter((k) => props[k]?.pathArg === true);
}

export async function resolvePathArgs(def: import('../../types.ts').ToolDef, args: Record<string, unknown>, ws: { resolve(p?: string): Promise<string> }): Promise<{ args: Record<string, unknown>; resolved: Record<string, string>; }> {
  const keys = pathArgsOf(def);
  if (keys.length === 0) return { args, resolved: {} };

  const out: Record<string, unknown> = { ...args };
  const resolved: Record<string, string> = {};

  for (const key of keys) {
    const raw = args[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== 'string') {
      throw new ToolError(`${key} must be a path string, received ${Array.isArray(raw) ? 'an array' : typeof raw}`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: `Pass ${key} as a single workspace-relative path.`,
      });
    }
    const abs = await ws.resolve(raw);
    out[key] = abs;
    resolved[key] = abs;
  }

  return { args: out, resolved };
}