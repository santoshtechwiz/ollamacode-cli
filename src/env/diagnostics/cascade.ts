import { isEditableSource } from './paths';

/** Many errors concentrated in one file are one broken construct reported many times, not that many bugs. */
const CASCADE_MIN = 4;
const CASCADE_SHARE = 0.7;

interface DiagnosticCascade {
  /** The file holding the pile-up, as the compiler spelled it. */
  file: string;
  /** How many errors are in that file. */
  count: number;
  /** How many editable-source errors the run reported in total. */
  total: number;
  /** The earliest one by line — the likeliest cause; the rest are usually its wake. */
  first: import('../../types.ts').Diagnostic;
}

function fileKey(file: string | undefined): string {
  return String(file ?? '').replace(/\\/g, '/').toLowerCase();
}

function errorsInSource(list: import('../../types.ts').Diagnostic[] | undefined, root?: string) {
  return (list ?? []).filter((d) => d.severity !== 'warning' && isEditableSource(d.file, root));
}

function groupByFile(list: import('../../types.ts').Diagnostic[]) {
  const byFile = new Map<string, import('../../types.ts').Diagnostic[]>();
  for (const d of list) {
    const key = fileKey(d.file);
    const bucket = byFile.get(key);
    if (bucket) bucket.push(d);
    else byFile.set(key, [d]);
  }
  return byFile;
}

function earliest(list: import('../../types.ts').Diagnostic[]): import('../../types.ts').Diagnostic {
  return list.reduce((a, b) => ((b.line ?? Infinity) < (a.line ?? Infinity) ? b : a));
}

/** One file dominating the failure output, or null when the errors are spread around and each really is its own problem. */
function detectCascade(
  list?: import('../../types.ts').Diagnostic[],
  root?: string
): DiagnosticCascade | null {
  const errors = errorsInSource(list, root);
  if (errors.length < CASCADE_MIN) return null;

  let top: import('../../types.ts').Diagnostic[] | null = null;
  for (const bucket of groupByFile(errors).values()) {
    if (!top || bucket.length > top.length) top = bucket;
  }
  if (!top || top.length < CASCADE_MIN) return null;
  if (top.length / errors.length < CASCADE_SHARE) return null;

  return { file: String(top[0].file), count: top.length, total: errors.length, first: earliest(top) };
}

export function primaryDiagnostic(list?: import('../../types.ts').Diagnostic[], root?: string): import('../../types.ts').Diagnostic | undefined {
  // In a cascade, point at the earliest error rather than whichever the compiler printed first.
  const cascade = detectCascade(list, root);
  if (cascade) return cascade.first;
  return (list ?? []).find((d) => isEditableSource(d.file, root));
}
