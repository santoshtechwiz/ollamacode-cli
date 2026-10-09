import type { Diagnostic } from '../../types';

// Helpers shared by the output parsers.

export function dedupe(list: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return list.filter((d) => {
    const key = `${d.file}:${d.line ?? ''}:${d.code ?? ''}:${d.symbol ?? ''}:${d.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The first quoted token in compiler prose: `'ProductManager' could not be found`, `No module named 'bar'`. */
export function quotedName(text: string): string | null {
  const m = /['"`]([^'"`\n]{1,120})['"`]/.exec(String(text ?? ''));
  return m?.[1]?.trim() || null;
}

/** Tag a diagnostic as referenced-but-undefined when its code says so. */
export function tagMissingByCode(diag: { code?: string; message?: string; kind?: string; symbol?: string }, codes: ReadonlySet<string>): void {
  if (!diag.code || !codes.has(String(diag.code).toUpperCase())) return;
  diag.kind = 'missing';
  diag.symbol = quotedName(String(diag.message ?? '')) ?? '';
}

export function scan(output: string, re: RegExp, build: (m: RegExpExecArray) => any): any[] {
  const out: any[] = [];
  for (let m = re.exec(output); m !== null; m = re.exec(output)) {
    const d = build(m);
    if (d) out.push(d);
  }
  return out;
}
