import { parseBlocks } from './markdown';
import { loadXlsx } from '../xlsx';

const MAX_SHEET_NAME = 31;
const MAX_COL_WIDTH = 60;

export interface SheetOutcome {
  bytes: Uint8Array;
  sheets: Array<{ name: string; rows: number }>;
}

// A cell that is plainly a number is stored as one, so sums and sorting work in Excel; "007" and "1,234 km" stay text.
function cellValue(text: string): string | number {
  const t = text.trim();
  return /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(t) ? Number(t) : t;
}

// Excel rejects sheet names over 31 characters, with []:*?/\ in them, or repeated.
function sheetName(wanted: string, taken: Set<string>): string {
  const base = (wanted.replace(/[[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim() || 'Sheet').slice(0, MAX_SHEET_NAME);
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base.slice(0, MAX_SHEET_NAME - String(n).length - 1)} ${n}`;
  taken.add(name.toLowerCase());
  return name;
}

/** Each markdown table becomes a sheet named after the heading above it; content without tables becomes one sheet of lines. */
export async function writeSpreadsheet(markdown: string, title?: string): Promise<SheetOutcome> {
  const XLSX = await loadXlsx();
  const blocks = parseBlocks(markdown);
  const taken = new Set<string>();
  const book = XLSX.utils.book_new();
  const sheets: SheetOutcome['sheets'] = [];

  const add = (name: string, rows: Array<Array<string | number>>) => {
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    const cols = Math.max(0, ...rows.map((r) => r.length));
    sheet['!cols'] = Array.from({ length: cols }, (_, c) => ({ wch: Math.min(MAX_COL_WIDTH, Math.max(8, ...rows.map((r) => String(r[c] ?? '').length + 2))) }));
    const unique = sheetName(name, taken);
    XLSX.utils.book_append_sheet(book, sheet, unique);
    sheets.push({ name: unique, rows: rows.length });
  };

  let heading = title ?? '';
  for (const block of blocks) {
    if (block.kind === 'heading') heading = block.text;
    if (block.kind === 'table') add(heading || `Table ${sheets.length + 1}`, [block.header, ...block.rows.map((r) => r.map(cellValue))]);
  }

  if (sheets.length === 0) {
    const lines = blocks.flatMap((b) => {
      switch (b.kind) {
        case 'heading': case 'paragraph': case 'code': return b.text.split('\n');
        case 'list': return b.items;
        default: return [];
      }
    });
    add(title || 'Sheet1', lines.filter((l) => l.trim()).map((l) => [cellValue(l)]));
  }

  return { bytes: new Uint8Array(XLSX.write(book, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer), sheets };
}
