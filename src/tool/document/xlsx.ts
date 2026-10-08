import { TOOL_ERROR_CODE } from '../../protocol';
import { ToolError } from '../core/tool-error';

/**
 * The spreadsheet library, loaded on first use. It is an optional dependency (served from SheetJS's own site, which
 * some networks block), so an install without it still works and only spreadsheets say they are unavailable.
 */
/**
 * The part of the library ocode uses, typed here so the code type-checks whether or not the optional package (and its
 * types) is installed.
 */
interface XlsxSheet { [key: string]: any }
interface XlsxBook { SheetNames: string[]; Sheets: Record<string, XlsxSheet | undefined> }
interface XlsxRange { s: { r: number; c: number }; e: { r: number; c: number } }
interface XlsxLib {
  read(data: Uint8Array | ArrayBuffer, opts: Record<string, unknown>): XlsxBook;
  write(book: XlsxBook, opts: { type: 'array' | 'buffer'; bookType: string }): ArrayBuffer | Uint8Array;
  utils: {
    decode_range(ref: string): XlsxRange;
    encode_col(col: number): string;
    sheet_to_json<T>(sheet: XlsxSheet, opts: Record<string, unknown>): T[];
    book_new(): XlsxBook;
    aoa_to_sheet(rows: unknown[][]): XlsxSheet;
    book_append_sheet(book: XlsxBook, sheet: XlsxSheet, name: string): void;
  };
}

// Named through a variable so the compiler does not try to resolve the optional package.
const XLSX_PACKAGE = 'xlsx';

export async function loadXlsx(): Promise<XlsxLib> {
  try {
    const mod: any = await import(XLSX_PACKAGE);
    return (mod.default ?? mod) as XlsxLib;
  } catch (err) {
    const missing = /MODULE_NOT_FOUND/.test(String((err as { code?: string })?.code)) && /['"]xlsx['"]/.test(String((err as Error)?.message));
    if (!missing) throw err;
    throw new ToolError('Spreadsheets are unavailable: the optional xlsx package is not installed', {
      code: TOOL_ERROR_CODE.ENOTSUPPORTED,
      hint: 'Tell the user that reading and writing .xlsx files needs the xlsx package (npm install, with access to cdn.sheetjs.com). PDFs still work.',
    });
  }
}
