const FENCE = /^\s{0,3}(```+|~~~+)/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DELIM = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

export type BlockKind = 'paragraph' | 'heading' | 'code' | 'table' | 'list' | 'quote' | 'hr';

export interface Segmentation {
  blocks: { kind: BlockKind; text: string; }[];
  rest: string;
  open: { kind: BlockKind; lines: number; } | null;
}

function isBlank(line: string): boolean {
  return line.trim().length === 0;
}

function startsNewBlock(line: string): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line);
}

export function splitBlocks(text: string): Segmentation {
  const raw = String(text ?? '');
  const all = raw.split('\n');
  const partial = all[all.length - 1];
  const lines = all.slice(0, -1);

  const blocks: any[] = [];
  let i = 0;
  let openAt = lines.length;
  let openKind: any = null;

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      i++;
      continue;
    }

    if (FENCE.test(line)) {
      const marker = (line.match(FENCE) ?? [])[1] ?? '```';
      const fenceChar = marker[0];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const m = lines[j].match(FENCE);
        if (m && m[1][0] === fenceChar && m[1].length >= marker.length) {
          closed = true;
          break;
        }
      }
      if (!closed) {
        openAt = i;
        openKind = 'code';
        break;
      }
      blocks.push({ kind: 'code', text: lines.slice(i, j + 1).join('\n') });
      i = j + 1;
      continue;
    }

    if (HEADING.test(line)) {
      blocks.push({ kind: 'heading', text: line });
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push({ kind: 'hr', text: line });
      i++;
      continue;
    }

    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_DELIM.test(lines[i + 1])) {
      let j = i;
      while (j < lines.length && TABLE_ROW.test(lines[j])) j++;
      if (j >= lines.length) {
        openAt = i;
        openKind = 'table';
        break;
      }
      blocks.push({ kind: 'table', text: lines.slice(i, j).join('\n') });
      i = j;
      continue;
    }

    if (QUOTE.test(line)) {
      let j = i;
      while (j < lines.length && QUOTE.test(lines[j])) j++;
      if (j >= lines.length) {
        openAt = i;
        openKind = 'quote';
        break;
      }
      blocks.push({ kind: 'quote', text: lines.slice(i, j).join('\n') });
      i = j;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        if (LIST_ITEM.test(l) || /^\s+\S/.test(l)) {
          j++;
          continue;
        }
        if (isBlank(l)) {
          const next = lines[j + 1];
          if (next !== undefined && (LIST_ITEM.test(next) || /^\s+\S/.test(next))) {
            j += 1;
            continue;
          }
        }
        break;
      }
      if (j >= lines.length) {
        openAt = i;
        openKind = 'list';
        break;
      }
      blocks.push({ kind: 'list', text: lines.slice(i, j).join('\n') });
      i = j;
      continue;
    }

    let j = i + 1;
    while (j < lines.length && !isBlank(lines[j]) && !startsNewBlock(lines[j])) j++;
    if (j >= lines.length) {
      openAt = i;
      openKind = 'paragraph';
      break;
    }
    blocks.push({ kind: 'paragraph', text: lines.slice(i, j).join('\n') });
    i = j;
  }

  const restLines = lines.slice(openAt);
  const rest = [...restLines, partial].join('\n');
  const openLines = restLines.length + (partial.trim() ? 1 : 0);

  return {
    blocks,
    rest,
    open: rest.trim() ? { kind: openKind ?? guessKind(rest), lines: openLines } : null,
  };
}

function guessKind(rest: string): BlockKind {
  const first = rest.split('\n').find((l) => l.trim()) ?? '';
  if (FENCE.test(first)) return 'code';
  if (HEADING.test(first)) return 'heading';
  if (QUOTE.test(first)) return 'quote';
  if (LIST_ITEM.test(first)) return 'list';
  if (TABLE_ROW.test(first)) return 'table';
  return 'paragraph';
}

export function finishBlocks(rest: string): { kind: BlockKind; text: string; }[] {
  const raw = String(rest ?? '');
  if (!raw.trim()) return [];
  const fences = (raw.match(/^\s{0,3}(?:```+|~~~+)/gm) ?? []).length;
  const closed = fences % 2 === 1 ? `${raw}\n\`\`\`` : raw;
  const { blocks, rest: leftover } = splitBlocks(`${closed}\n`);
  if (leftover.trim()) blocks.push({ kind: guessKind(leftover), text: leftover.replace(/\n+$/, '') });
  return blocks;
}

