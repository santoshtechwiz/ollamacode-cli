import { ToolError, codeFromErrno } from './tool-error';
import { TOOL_RESULT_STATUS, statusForCode } from '../../protocol';

/** The canonical result of one tool call. */
export interface ToolResult {
  ok: boolean;
  kind: ToolResultKind;
  status?: import('../../protocol.ts').ToolResultStatus;
  data?: any;
  display?: string;
  error?: string;
  hint?: string;
  /** Advice for the model alone: the model's copy of the result carries it, the screen never shows it. */
  modelNote?: string;
  /** Detail for the person alone, shown under `display` on screen and never sent to the model: what it already knows. */
  screen?: string;
  note?: string;
  code?: import('../../protocol.ts').ToolErrorCode;
  truncated?: boolean;
  /** Stable id of the execution that produced this result (runtime-stamped). */
  executionId?: string;
  /** Which attempt produced it: 0 is the first run after validation. */
  attempt?: number;
  /** Wall-clock time the execution took, ms (runtime-stamped). */
  durationMs?: number;
}

export type ToolResultKind = import('../../protocol.ts').ResultKind;
export type ToolErrorCode = import('../../protocol.ts').ToolErrorCode;

export function ok({ kind = 'text', display = '', data = {}, truncated = false }: any = {}): ToolResult {
  return { ok: true, kind, display, data, truncated, status: TOOL_RESULT_STATUS.SUCCESS };
}

export function fail(error: string, { code = 'EUNKNOWN', hint, note, display, data = {}, status }: any = {}): ToolResult {
  return {
    ok: false,
    kind: 'none',
    error,
    ...(hint ? { hint } : {}),
    ...(note ? { note } : {}),
    ...(display ? { display } : {}),
    code,
    data,
    status: status ?? statusForCode(code) ?? TOOL_RESULT_STATUS.FAILED,
  };
}

export function fromError(err: unknown): ToolResult {
  if (err instanceof ToolError) {
    return fail(err.message, { code: err.code as ToolErrorCode, hint: err.hint });
  }
  const e = (err as { message?: string; code?: string; });
  const message = e?.message ?? String(err);
  const code = codeFromErrno(err);
  const hint =
    code === 'ENOTDIR'
      ? 'A file exists where a directory is expected somewhere in this path. Check the parents with list_directory; the file in the way has to be moved or removed first.'
      : undefined;
  return fail(message, { code, hint });
}

/** A cut that never ends on half a surrogate pair; a lone half reads as mojibake. */
export function dropTrailingSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

/** A cut that never begins on the low half of a surrogate pair. */
export function dropLeadingSurrogate(s: string): string {
  const first = s.charCodeAt(0);
  return first >= 0xdc00 && first <= 0xdfff ? s.slice(1) : s;
}

export function clamp(text: string, limit: number): { text: string; truncated: boolean; } {
  const s = String(text ?? '');
  if (s.length <= limit) return { text: s, truncated: false };
  return {
    text: `${dropTrailingSurrogate(s.slice(0, limit))}\n…[truncated ${s.length - limit} more characters]`,
    truncated: true,
  };
}