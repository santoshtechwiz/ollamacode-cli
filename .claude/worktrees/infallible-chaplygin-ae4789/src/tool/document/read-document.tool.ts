import fsp from 'node:fs/promises';
import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { ToolError } from '../core/tool-error';
import { TtlCache } from '../content/cache';
import { readerFor, supportedExtensions } from './readers/index';
import { renderDocument } from './view';
import type { ParsedDocument } from './types';

const MAX_BYTES = 50 * 1024 * 1024;
// Under the agent's shared per-result limit (8000 by default) so nothing is cut out of the middle.
const DEFAULT_CHARS = 6_000;
const MAX_CHARS = 30_000;
const CACHE_TTL_MS = 15 * 60_000;

// Parsing is the slow part, so a follow-up query or page range on the same unchanged file reuses it.
const parsed = new TtlCache<ParsedDocument>(8);

export default defineTool({
  name: 'read_document',
  aliases: ['read_pdf', 'read_excel', 'read_spreadsheet'],
  argAliases: {
    file: 'path',
    file_path: 'path',
    search: 'query',
    page: 'pages',
  },
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Reading a document',
  label: 'Read Document',
  brief: 'Read or search a PDF or Excel file (.pdf, .xlsx, .xls): an overview, matching passages/rows, or chosen pages/sheet.',
  description:
    'Read a PDF or spreadsheet (.pdf, .xlsx, .xlsm, .xls) from the workspace without loading all of it. With no options it returns an overview ' +
    '(the whole thing when small). Pass query to get only the matching passages or rows with their page or row numbers, pages to read a PDF ' +
    'page range, or sheet to read one sheet. Prefer query for large files. For text files use read_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative file path' },
      query: { type: 'string', description: 'Words to search for; returns only the relevant passages or rows' },
      pages: { type: 'string', description: 'PDF pages to read, e.g. "3" or "2-5"' },
      sheet: { type: 'string', description: 'Spreadsheet sheet name to read' },
      max_chars: { type: 'number', description: `Maximum characters to return (default ${DEFAULT_CHARS})` },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    const abs = String(args.path);
    const rel = ctx.ws.rel(abs);
    const reader = readerFor(abs);
    if (!reader) {
      return fail(`${rel} is not a document format read_document understands`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: `Supported: ${supportedExtensions().join(', ')}. Use read_file for text files.`,
      });
    }
    try {
      const st = await fsp.stat(abs);
      if (st.isDirectory()) return fail(`${rel} is a directory`, { code: TOOL_ERROR_CODE.EISDIR });
      if (st.size > MAX_BYTES) {
        return fail(`${rel} is too large to read (${Math.round(st.size / 1048576)} MB, limit ${MAX_BYTES / 1048576} MB)`, { code: TOOL_ERROR_CODE.ETOOLARGE });
      }
      const key = `${abs}|${st.mtimeMs}|${st.size}`;
      let doc = parsed.get(key);
      if (!doc) {
        try {
          doc = await reader.read(new Uint8Array(await fsp.readFile(abs)));
        } catch (err) {
          // A reader that cannot run at all says so itself; anything else is this file failing to parse.
          if (err instanceof ToolError) return fromError(err);
          const message = (err as Error)?.message ?? String(err);
          const locked = /password/i.test(message) || (err as { name?: string })?.name === 'PasswordException';
          return fail(
            locked ? `${rel} is password-protected, so its contents cannot be read` : `${rel} could not be read as a ${reader.format}: ${message}`,
            { code: TOOL_ERROR_CODE.EINVAL },
          );
        }
        parsed.set(key, doc, CACHE_TTL_MS);
      }
      const maxChars = Number(args.max_chars) > 0 ? Math.min(Number(args.max_chars), MAX_CHARS) : DEFAULT_CHARS;
      const view = renderDocument(doc, rel, {
        query: args.query ? String(args.query) : undefined,
        pages: args.pages !== undefined && args.pages !== null && args.pages !== '' ? String(args.pages) : undefined,
        sheet: args.sheet ? String(args.sheet) : undefined,
        maxChars,
      });
      if (!view.ok) return fail(view.error, { code: TOOL_ERROR_CODE.EINVAL });
      return ok({
        kind: 'text',
        display: view.text,
        truncated: view.truncated,
        data: { path: rel, format: doc.format, sections: doc.sections.length },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});
