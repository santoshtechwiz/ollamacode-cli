import { TOOL_ERROR_CODE } from '../../protocol';
import { ToolError } from '../core/tool-error';

/**
 * The spreadsheet library, loaded on first use. It is an optional dependency (served from SheetJS's own site, which
 * some networks block), so an install without it still works and only spreadsheets say they are unavailable.
 */
export async function loadXlsx(): Promise<typeof import('xlsx')> {
  try {
    return await import('xlsx');
  } catch (err) {
    const missing = /MODULE_NOT_FOUND/.test(String((err as { code?: string })?.code)) && /['"]xlsx['"]/.test(String((err as Error)?.message));
    if (!missing) throw err;
    throw new ToolError('Spreadsheets are unavailable: the optional xlsx package is not installed', {
      code: TOOL_ERROR_CODE.ENOTSUPPORTED,
      hint: 'Tell the user that reading and writing .xlsx files needs the xlsx package (npm install, with access to cdn.sheetjs.com). PDFs still work.',
    });
  }
}
