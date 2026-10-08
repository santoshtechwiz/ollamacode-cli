import { highlightLine } from './highlight';

const MAX_LCS_CELLS = 4_000_000;

function lineDiff(a: string[], b: string[]): { type: string; line: string; }[] {
  const m = a.length;
  const n = b.length;
  if (m * n > MAX_LCS_CELLS) return coarseDiff(a, b);
  const dp = Array.from({ length: m + 1 }, () => Array.from({ length: n + 1 }, () => 0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const res: any[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      res.push({ type: 'equal', line: a[i] });
      i++; j++;
    } else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) {
      res.push({ type: 'add', line: b[j] });
      j++;
    } else if (i < m) {
      res.push({ type: 'remove', line: a[i] });
      i++;
    }
  }
  return res;
}

function coarseDiff(a: string[], b: string[]): { type: string; line: string; }[] {
  let start = 0;
  const maxStart = Math.min(a.length, b.length);
  while (start < maxStart && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const res: any[] = [];
  for (let i = 0; i < start; i++) res.push({ type: 'equal', line: a[i] });
  for (let i = start; i < endA; i++) res.push({ type: 'remove', line: a[i] });
  for (let i = start; i < endB; i++) res.push({ type: 'add', line: b[i] });
  for (let i = endA; i < a.length; i++) res.push({ type: 'equal', line: a[i] });
  return res;
}

export function renderDiff(oldContent: string, newContent: string, { context = 3, maxLines = 80 }: any = {}): string {
  const a = String(oldContent ?? '').split('\n');
  const b = String(newContent ?? '').split('\n');
  if (a.length === 1 && a[0] === '' && b.length === 1 && b[0] === '') return '  (no content)';

  const diff = lineDiff(a, b);
  const keep = new Set();
  diff.forEach((h, idx) => {
    if (h.type !== 'equal') {
      for (let k = Math.max(0, idx - context); k <= Math.min(diff.length - 1, idx + context); k++) keep.add(k);
    }
  });
  if (keep.size === 0) return '  (no visible changes)';

  let out: any[] = [];
  let sawKept = false;
  let gapPrinted = false;
  let oldLine = 1, newLine = 1;
  const withNumbers = diff.map((h) => {
    const o = h.type !== 'add' ? oldLine++ : undefined;
    const n = h.type !== 'remove' ? newLine++ : undefined;
    return { ...h, oldNum: o, newNum: n };
  });

  for (let idx = 0; idx < withNumbers.length; idx++) {
    if (!keep.has(idx)) {
      if (sawKept && !gapPrinted) {
        out.push('  …');
        gapPrinted = true;
      }
      continue;
    }
    sawKept = true;
    gapPrinted = false;
    const h = withNumbers[idx];
    if (h.type === 'remove') out.push(`- ${String(h.oldNum).padStart(3)}     │ ${h.line}`);
    else if (h.type === 'add') out.push(`+     ${String(h.newNum).padStart(3)} │ ${h.line}`);
    else out.push(`  ${String(h.oldNum).padStart(3)} ${String(h.newNum).padStart(3)} │ ${h.line}`);
  }

  let truncated = false;
  if (out.length > maxLines) {
    truncated = true;
    out = out.slice(0, maxLines);
  }
  let header = '  ── Diff ──';
  if (truncated) header += ` (showing ${maxLines} of ${keep.size} lines)`;
  return [header, ...out].join('\n');
}

export function renderNewFile(content: string): string {
  const lines = String(content ?? '').split('\n');
  const preview = lines.slice(0, 60).map((l, i) => `+     ${(i + 1).toString().padStart(3)} │ ${l}`).join('\n');
  const more = lines.length > 60 ? `  … (${lines.length - 60} more lines)` : '';
  return ['  ── New file ──', preview, more].filter(Boolean).join('\n');
}

function splitDiffLine(line: string): { meta: string; code: string; } | null {
  const at = line.indexOf('│');
  if (at === -1) return null;
  return { meta: line.slice(0, at + 2), code: line.slice(at + 2) };
}

export function colorizeDiffLine(line: string, { red, green, dim, bold, cyan }: any, lang: string = ''): string {
  if (line.trimStart().startsWith('──')) return bold(cyan(line));
  const paint = line.startsWith('- ') ? red : line.startsWith('+ ') ? green : dim;
  const split = splitDiffLine(line);
  if (!split) return paint(line);
  const code = lang ? highlightLine(split.code, lang) : split.code;
  return `${paint(split.meta)}${code}`;
}

