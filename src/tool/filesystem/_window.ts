import { countLines } from './_match';

interface WindowOptions {
  /** Lines of context to show on each side of the named range. */
  pad?: number;
  /** Prefix every line with a marker, `> ` for the lines inside the range. */
  mark?: boolean;
}

/** A numbered slice of a file, as the model reads it when an edit did not apply. */
export function numberedWindow(
  content: string,
  from: number,
  to: number,
  { pad = 8, mark = false }: WindowOptions = {}
): string {
  const lines = content.split('\n');
  const total = countLines(content);
  const start = Math.max(1, Math.min(from, total) - pad);
  const end = Math.max(start, Math.min(total, Math.max(to, 1) + pad));
  const width = String(end).length;
  const gutter = mark ? '  ' : '';
  const out: string[] = [];
  for (let n = start; n <= end; n++) {
    const flag = mark ? (n >= from && n <= to ? '> ' : '  ') : '';
    out.push(`${flag}${String(n).padStart(width)}: ${String(lines[n - 1] ?? '').replace(/\r$/, '')}`);
  }
  if (start > 1) out.unshift(`${gutter}   …(${start - 1} earlier line${start === 2 ? '' : 's'})`);
  if (end < total) out.push(`${gutter}   …(${total - end} more line${total - end === 1 ? '' : 's'})`);
  return out.join('\n');
}
