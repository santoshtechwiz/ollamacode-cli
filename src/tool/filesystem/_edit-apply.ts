import MagicString from 'magic-string';

import type { MatchRange } from './_match';

/** One concrete splice, already located against the original file text. */
export interface TextEditOp {
  start: number;
  end: number;
  replacement: string;
}

type ApplyEditsResult =
  | { ok: true; content: string }
  | { ok: false; why: string };

function overlaps(a: MatchRange, b: MatchRange): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Whether any two ops claim overlapping spans of the original text. */
function findOverlappingEdits(ops: TextEditOp[]): { a: TextEditOp; b: TextEditOp } | null {
  const sorted = [...ops].sort((x, y) => x.start - y.start || x.end - y.end);
  for (let i = 1; i < sorted.length; i++) {
    if (overlaps(sorted[i - 1], sorted[i])) {
      return { a: sorted[i - 1], b: sorted[i] };
    }
  }
  return null;
}

/** Apply every planned range to `content` in one pass. */
export function applyTextEdits(content: string, ops: TextEditOp[]): ApplyEditsResult {
  if (ops.length === 0) return { ok: true, content };

  const conflict = findOverlappingEdits(ops);
  if (conflict) {
    return {
      ok: false,
      why:
        `edits overlap at offsets ${conflict.a.start}-${conflict.a.end} and ` +
        `${conflict.b.start}-${conflict.b.end}`,
    };
  }

  const s = new MagicString(content);
  try {
    for (const op of ops) {
      if (op.start === op.end) {
        if (op.replacement) s.appendLeft(op.start, op.replacement);
        continue;
      }
      s.overwrite(op.start, op.end, op.replacement);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, why: `conflicting edits — ${message}` };
  }

  return { ok: true, content: s.toString() };
}
