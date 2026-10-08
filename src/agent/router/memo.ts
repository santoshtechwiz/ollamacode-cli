import path from 'node:path';

import { TOOL_ERROR_CODE } from '../../protocol';
import { stableStringify } from '../../core/stable-json';
import { fileStamp } from '../../core/paths';
import { resolveToolName } from './names';
import { TOOL_META } from '../../tool/index';
import { normalizeArgs } from './args';

const ARGUMENT_FAILURES: Set<import('../../protocol.ts').ToolErrorCode> = new Set([
  TOOL_ERROR_CODE.EINVAL,
  TOOL_ERROR_CODE.EAMBIGUOUS,
  TOOL_ERROR_CODE.ENOMATCH,
]);

/** The identity of a call as the executor will actually run it: resolved name, normalized arguments. */
export function callSignature(name: string, args: Record<string, unknown>): string {
  const resolved = resolveToolName(String(name ?? ''));
  const safe = args && typeof args === 'object' ? args : {};
  return `${resolved}:${stableStringify(normalizeArgs(safe, TOOL_META[resolved]))}`;
}

function pathKey(p: unknown): string | null {
  if (typeof p !== 'string' || p === '') return null;
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

interface PriorFailure {
  error: string;
  code: string;
  hint?: string;
  display?: string;
  /** Absolute path the rejection was about, when it was about one. */
  file?: string | null;
  /** That file's identity on disk when the rejection was recorded. */
  stamp?: string | null;
}

export interface InvalidCallMemo {
  recall: (name: string, args: Record<string, unknown>) => PriorFailure | null;
  note: (name: string, args: Record<string, unknown>, result: import('../../types.ts').ToolResult, scopePath?: string | null) => void;
  invalidatePath: (file: string) => void;
  invalidateAll: () => void;
  size: () => number;
}

export function createInvalidCallMemo(): InvalidCallMemo {
  const seen = new Map();
  const byPath = new Map();

  function forget(sig: string) {
    seen.delete(sig);
  }

  return {
    recall(name, args) {
      const sig = callSignature(name, args);
      const prior = seen.get(sig) ?? null;
      if (!prior) return null;
      // A rejection is only evidence while the file it was about still looks the way it did.
      if (prior.file && fileStamp(prior.file) !== prior.stamp) {
        forget(sig);
        return null;
      }
      return prior;
    },

    note(name: string, args: Record<string, unknown>, result: import('../../types.ts').ToolResult, scopePath: string | null = null) {
      if (result?.ok) return;
      if (!result?.code || !ARGUMENT_FAILURES.has(result.code)) return;
      const code = result.code;
      const sig = callSignature(name, args);
      const abs = typeof scopePath === 'string' && scopePath !== '' ? path.resolve(scopePath) : null;
      seen.set(sig, {
        error: String(result.error ?? ''),
        code,
        hint: result.hint ? String(result.hint) : undefined,
        display: result.display ? String(result.display) : undefined,
        file: abs,
        stamp: abs ? fileStamp(abs) : null,
      });
      const key = pathKey(scopePath);
      if (!key) return;
      const set = byPath.get(key) ?? new Set();
      set.add(sig);
      byPath.set(key, set);
    },

    invalidatePath(file: string) {
      const key = pathKey(file);
      if (!key) return;
      for (const sig of byPath.get(key) ?? []) forget(sig);
      byPath.delete(key);
    },

    invalidateAll() {
      for (const sigs of byPath.values()) for (const sig of sigs) forget(sig);
      byPath.clear();
    },

    size: () => seen.size,
  };
}

export function repeatedInvalidMessage(name: string, prior: PriorFailure): string {
  return (
    `${name} was already called with exactly these arguments and rejected: ${prior.error}\n` +
    'The call was not run again — identical arguments always produce this same result. ' +
    'Change the arguments before calling it again, or use a different tool.'
  );
}

