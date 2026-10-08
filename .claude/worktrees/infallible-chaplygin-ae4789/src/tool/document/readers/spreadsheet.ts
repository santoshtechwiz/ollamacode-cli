import type { DocumentReader, DocSection } from '../types';
import { loadXlsx } from '../xlsx';

const MAX_ROWS = 100_000;
const CELL_CHARS = 200;

function cell(value: unknown): string {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > CELL_CHARS ? `${s.slice(0, CELL_CHARS - 1)}…` : s;
}

export const spreadsheetReader: DocumentReader = {
  format: 'spreadsheet',
  extensions: ['.xlsx', '.xlsm', '.xls'],
  mimeType: /spreadsheetml|ms-excel/i,
  async read(bytes) {
    const XLSX = await loadXlsx();
    const book = XLSX.read(bytes, { type: 'array', dense: true, cellDates: true, sheetRows: MAX_ROWS + 1 });
    let clipped = false;
    const sections: DocSection[] = book.SheetNames.map((name) => {
      const sheet = book.Sheets[name];
      const ref = sheet?.['!ref'];
      if (!ref) return { label: name, blocks: [], summary: 'empty' };
      const range = XLSX.utils.decode_range(ref);
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, blankrows: true, defval: '' });
      const headerAt = rows.findIndex((r) => r.some((v) => cell(v)));
      if (headerAt < 0) return { label: name, blocks: [], summary: 'empty' };
      const header = rows[headerAt].map((v, c) => cell(v) || XLSX.utils.encode_col(range.s.c + c));
      // Each row is rendered against the header so a matched row reads on its own, with its real sheet row number.
      const blocks: string[] = [];
      for (let i = headerAt + 1; i < rows.length; i++) {
        const fields = rows[i].map((v, c) => [header[c] ?? XLSX.utils.encode_col(range.s.c + c), cell(v)]).filter(([, v]) => v);
        if (fields.length) blocks.push(`row ${range.s.r + i + 1}: ${fields.map(([k, v]) => `${k}=${v}`).join(' | ')}`);
      }
      if (range.e.r - range.s.r + 1 > MAX_ROWS) clipped = true;
      return {
        label: name,
        blocks,
        header: `columns: ${header.join(' | ')}`,
        summary: `${blocks.length} rows × ${header.length} columns`,
      };
    });
    return {
      format: 'spreadsheet',
      unit: 'sheet',
      sections,
      ...(clipped ? { note: `Only the first ${MAX_ROWS} rows of each sheet were read.` } : {}),
    };
  },
};
