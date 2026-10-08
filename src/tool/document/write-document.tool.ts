import fsp from 'node:fs/promises';
import path from 'node:path';
import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { noteChange } from '../filesystem/_fs';
import { writePdf } from './writers/pdf';
import { writeSpreadsheet } from './writers/spreadsheet';

function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`;
}

export default defineTool({
  name: 'write_document',
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Creating a document',
  label: 'Write Document',
  brief: 'Create a PDF or Excel file (.pdf, .xlsx) from markdown text and tables.',
  risky: true,
  restorable: true,
  outputOnly: true,
  description:
    'Create a PDF or Excel file from markdown. The format follows the path: .pdf lays out headings, paragraphs, lists, ' +
    'tables and code on A4 pages; .xlsx turns each markdown table into a sheet named after the heading above it (content ' +
    'without tables becomes one sheet of lines). Replaces the file if it exists. Write the full content in one call. ' +
    'For .md, .csv, .html or other text files use write_file; to read a PDF or spreadsheet use read_document.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative output path ending in .pdf or .xlsx' },
      content: { type: 'string', bulkArg: true, description: 'Markdown: headings, paragraphs, lists and | tables |' },
      title: { type: 'string', description: 'Optional document title (PDF heading and metadata, or the sheet name when there is no table)' },
    },
    required: ['path', 'content'],
  },
  async execute(args, ctx) {
    const abs = String(args.path);
    const rel = ctx.ws.rel(abs);
    const ext = path.extname(abs).toLowerCase();
    const content = String(args.content ?? '');
    const title = args.title ? String(args.title).trim() || undefined : undefined;
    if (ext !== '.pdf' && ext !== '.xlsx') {
      return fail(`write_document creates .pdf or .xlsx files, not ${ext || 'files without an extension'}`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'End the path in .pdf or .xlsx. For .md, .csv, .html or other text files use write_file.',
      });
    }
    if (!content.trim()) return fail('Missing required argument: content', { code: TOOL_ERROR_CODE.EINVAL });
    try {
      const existed = await fsp.stat(abs).then((s) => s.isFile(), () => false);
      let bytes: Uint8Array;
      let summary: string;
      if (ext === '.pdf') {
        const pdf = await writePdf(content, title);
        bytes = pdf.bytes;
        summary = `${pdf.pages} page${pdf.pages === 1 ? '' : 's'}` +
          (pdf.dropped ? `; ${pdf.dropped} character${pdf.dropped === 1 ? '' : 's'} the PDF font cannot show (such as emoji) were left out` : '');
      } else {
        const book = await writeSpreadsheet(content, title);
        bytes = book.bytes;
        summary = book.sheets.map((s) => `sheet "${s.name}" with ${s.rows} row${s.rows === 1 ? '' : 's'}`).join(', ');
      }
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, bytes);
      noteChange(ctx, existed ? 'overwrite' : 'create', abs, 'file');
      return ok({
        kind: 'file',
        display: `${existed ? 'Replaced' : 'Created'} ${rel} (${size(bytes.length)}): ${summary}.`,
        data: { path: rel, bytes: bytes.length, created: !existed, existedBefore: existed, existsAfter: true },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});
