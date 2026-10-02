import fsp from 'node:fs/promises';
import path from 'node:path';

import { symbolAtLine } from '../../tool/filesystem/_syntax';
import type { Diagnostic } from '../../types';

/** No location claim to check: pseudo-files, missing lines, non-source. */
function isCheckable(d: Diagnostic): boolean {
  const file = String(d.file ?? '');
  if (!file || !d.line) return false;
  return !file.startsWith('(') && !file.startsWith('<') && !file.startsWith('node:');
}

function lineCount(content: string): number {
  if (content === '') return 0;
  const n = content.split('\n').length;
  return content.endsWith('\n') ? n - 1 : n;
}

/**
 * Check regex-parsed diagnostics against the actual files: drop locations
 * that are provably wrong (the file reads and the line is outside it) and
 * attach the enclosing definition name, so the model gets *which* test or
 * function a location sits in rather than a bare file:line.
 *
 * Conservative by design: an unreadable file, a missing grammar, or a parse
 * failure keeps the diagnostic untouched. Only a verified miss is dropped —
 * a stale line number sends the model to the wrong place with confidence.
 */
export async function verifyDiagnostics(
  list: Diagnostic[] | undefined,
  { root, cwd }: { root?: string; cwd?: string; } = {},
): Promise<Diagnostic[]> {
  const diags = list ?? [];
  if (diags.length === 0) return diags;
  const base = root ?? cwd ?? '.';
  const contents = new Map<string, string | null>();
  const out: Diagnostic[] = [];

  for (const d of diags) {
    if (!isCheckable(d)) {
      out.push(d);
      continue;
    }
    const file = String(d.file);
    const abs = path.isAbsolute(file) ? file : path.resolve(base, file);
    let content = contents.get(abs);
    if (content === undefined) {
      try {
        content = await fsp.readFile(abs, 'utf8');
      } catch {
        content = null;
      }
      contents.set(abs, content);
    }
    if (content === null) {
      out.push(d);
      continue;
    }
    const total = lineCount(content);
    if (d.line! < 1 || d.line! > total) continue;
    if (d.symbol) {
      out.push(d);
      continue;
    }
    const symbol = await symbolAtLine(abs, content, d.line!);
    out.push(symbol ? { ...d, symbol } : d);
  }
  return out;
}
