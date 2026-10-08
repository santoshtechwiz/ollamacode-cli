import { TOOL_ERROR_CODE } from '../../protocol';
import fsp from 'node:fs/promises';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError, clamp } from '../core/tool-result';
import { isBinaryFile, decodeUtf8 } from './_fs';
import { isJsonPath, stripBom } from './_json';
import { readerFor } from '../document/readers/index';
import { noteSeen } from './_seen';

const MAX_BYTES = 512 * 1024;
const MAX_DISPLAY = 60_000;

/** The text without the newline that ends its last line, so splitting it yields the file's lines and no phantom one. */
function withoutFinalNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

export default defineTool({
  name: 'read_file',
  aliases: ['view_file', 'cat', 'open_file'],
  argAliases: {
    file: 'path',
    filename: 'path',
    filepath: 'path',
    file_path: 'path',
    line_start: 'offset',
    start_line: 'offset',
    from_line: 'offset',
    start: 'offset',
    max_lines: 'limit',
    num_lines: 'limit',
    count: 'limit',
  },
  profiles: ['core', 'planning'],
  category: 'filesystem',
  readOnly: true,
  activity: 'Reading a file',
  label: 'Read File',
  brief: 'Read a text file. Use offset/limit to read a range of a large file.',
  description:
    'Read a text file from the workspace. Supports reading a line range via offset/limit for large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative file path' },
      offset: { type: 'number', description: 'First line to return (1-based)' },
      limit: { type: 'number', description: 'Maximum number of lines to return' },
      line_end: { type: 'number', description: 'Last line to return (1-based, alternative to limit)' },
    },
    required: ['path'],
  },
  async execute(args, ctx) {
    try {
      const abs = String(args.path);
      const rel = ctx.ws.rel(abs);


      const st = await fsp.lstat(abs);
      if (st.isDirectory()) {
        return fail(`${rel} is a directory`, {
          code: TOOL_ERROR_CODE.EISDIR,
          hint: 'Use list_directory to inspect a directory.',
        });
      }
      if (readerFor(abs)) {
        return fail(`${rel} is a document, not a text file`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Use read_document to read or search it.',
        });
      }
      if (st.size > MAX_BYTES) {
        return fail(`File too large: ${st.size} bytes (limit ${MAX_BYTES})`, {
          code: TOOL_ERROR_CODE.ETOOLARGE,
          hint: 'Read a range with offset/limit, or use grep_content to find the relevant lines.',
        });
      }
      if (await isBinaryFile(abs)) {
        return fail(`${rel} is a binary file`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Binary files cannot be read as text.',
        });
      }

      const raw = await fsp.readFile(abs);
      const stripped = stripBom(decodeUtf8(raw).text);
      const hadBom = stripped.hadBom;
      const content = stripped.text;
      // A range is still read from this version: its line numbers are this version's.
      noteSeen(ctx?.state, rel);
      // A final newline ends the last line; it does not start another. Counted as one, a 6-line file read as 7, and an
      // edit at the line the read showed was refused by edit_file as past the end.
      const lines = withoutFinalNewline(content).split('\n');
      const jsonFile = isJsonPath(rel);
      const singleLineJson = jsonFile && lines.length <= 2 && content.trim().length > 2000;
      const offset = Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 1;
      let limit = Number(args.limit) > 0 ? Math.floor(Number(args.limit)) : undefined;
      if (limit === undefined && Number(args.line_end) > 0) {
        limit = Math.max(1, Math.floor(Number(args.line_end)) - offset + 1);
      }
      const sliced =
        offset > 1 || limit !== undefined
          ? lines.slice(offset - 1, limit ? offset - 1 + limit : undefined).join('\n')
          : content;

      // Numbered, nothing reads as "     1" with no text: a model took that for content, read the file again and again,
      // and invented text to search for.
      if (content === '') {
        return {
          ...ok({
            kind: 'file',
            display: `${rel} is empty (0 bytes)`,
            data: { path: rel, size: st.size, lines: 0, offset, returnedLines: 0, fullContent: '', bom: hadBom },
          }),
          modelNote: 'There is no text in it to search for: give it content with write_file.',
        };
      }
      if (offset > lines.length) {
        return ok({
          kind: 'file',
          display: `${rel} has ${lines.length} line${lines.length === 1 ? '' : 's'}; there is nothing at line ${offset} or after it`,
          data: { path: rel, size: st.size, lines: lines.length, offset, returnedLines: 0, fullContent: '', bom: hadBom },
        });
      }

      let displaySliced = sliced;
      let prettyNote = '';
      if (singleLineJson && offset === 1 && limit === undefined) {
        try {
          const parsed = JSON.parse(content.trim());
          const pretty = JSON.stringify(parsed, null, 2);
          if (pretty.length < MAX_DISPLAY * 2) {
            displaySliced = pretty;
            prettyNote = 'display pretty-printed; the file itself is one line, so edit_file text copied from here will not match — change it with write_file.\n';
          }
        } catch {}
      }
      const { text, truncated } = clamp(displaySliced, MAX_DISPLAY);
      const numbered = withoutFinalNewline(text)
        .split('\n')
        .map((line, i) => `${String(offset + i).padStart(6)}\t${line}`)
        .join('\n');
      const display = truncated
        ? `${prettyNote}${numbered}\n${`— truncated — press Ctrl+O or run /open ${rel} to see full file (${lines.length} lines)`}`
        : `${prettyNote}${numbered}`;
      return ok({
        kind: 'file',
        display,
        truncated,
        data: {
          path: rel,
          size: st.size,
          lines: lines.length,
          offset,
          returnedLines: withoutFinalNewline(sliced).split('\n').length,
          fullContent: sliced,
          truncatedHint: truncated ? 'Press Ctrl+O' : undefined,
          bom: hadBom,
          prettyPrinted: Boolean(prettyNote),
        },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

