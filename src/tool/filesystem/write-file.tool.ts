import { TOOL_ERROR_CODE } from '../../protocol';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { statType, noteChange, findFileAncestor } from './_fs';
import { openTextFile, writeAndVerify, safeDiff } from './_text-file';
import { syntaxBreak } from './_syntax';
import { isJsonPath, validateJson, stripBom } from './_json';
import { lineDiff } from '../../ui/diff';
import { workspaceFor } from '../../agent/workspace/manager';

export const MAX_BYTES = 5 * 1024 * 1024;

type Edit = { search: string; replace: string };

// The edit_file calls that turn `before` into `after`: each changed block, widened with its neighbouring lines until its search text is unique.
function equivalentEdits(before: string, after: string): Edit[] | null {
  const a = before.split(/\r?\n/);
  const text = a.join('\n');
  const diff = lineDiff(a, after.split(/\r?\n/));
  const hunks: Array<{ from: number; to: number; added: string[] }> = [];
  let at = 0;
  for (let k = 0; k < diff.length; k++) {
    if (diff[k].type === 'equal') { at++; continue; }
    const hunk = { from: at, to: at, added: [] as string[] };
    for (; k < diff.length && diff[k].type !== 'equal'; k++) {
      if (diff[k].type === 'remove') hunk.to = ++at;
      else hunk.added.push(diff[k].line);
    }
    k--;
    hunks.push(hunk);
  }
  const edits: Edit[] = [];
  let reached = 0;
  for (const h of hunks) {
    let { from, to } = h;
    const search = () => a.slice(from, to).join('\n');
    const unique = () => search() !== '' && text.split(search()).length === 2;
    while (!unique() && (from > reached || to < a.length)) {
      if (from > reached) from--;
      if (!unique() && to < a.length) to++;
    }
    if (!unique()) return null;
    edits.push({ search: search(), replace: [...a.slice(from, h.from), ...h.added, ...a.slice(h.to, to)].join('\n') });
    reached = to;
  }
  return edits;
}

function coerceContent(value: unknown, isJson: boolean): { text: string; } | { error: string; } {
  if (typeof value === 'string') return { text: value };
  if (value === null || value === undefined) return { text: '' };
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { text: String(value) };
  }
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    if (isJson) {
      return {
        error:
          'content must be a JSON string, received array of strings. ' +
          'Stringify the JSON first (e.g. JSON.stringify with brackets and commas), or use json_patch to change one key.',
      };
    }
    return { text: value.join('\n') };
  }
  if (typeof value === 'object') {
    return {
      error: isJson
        ? 'content must be a JSON string, received object. Stringify it first, or use json_patch to change one key.'
        : `content must be a string, received ${Array.isArray(value) ? 'array' : typeof value}`,
    };
  }
  return {
    error: `content must be a string, received ${Array.isArray(value) ? 'array' : typeof value}`,
  };
}

export default defineTool({
  name: 'write_file',
  aliases: ['create_file', 'new_file', 'save_file'],
  argAliases: {
    file: 'path',
    filename: 'path',
    filepath: 'path',
    file_path: 'path',
    data: 'content',
    text: 'content',
    body: 'content',
  },
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Writing a file',
  label: 'Write',
  brief: 'Create a new UTF-8 text file, or append to one. Ensures the directory exists. To change an existing file, use edit_file.',
  risky: true,
  restorable: true,
  description:
    'Create a new file with the given content, or append to a file with mode="append". It does not change an existing ' +
    'file: to change part of one, use edit_file, which targets just the lines it names and leaves the rest untouched. ' +
    'To replace a whole existing file on purpose, delete it first, then create it. A file too large to emit in one ' +
    'reply is written in stages: one call to create it, then mode="append" for each following part. After writing, ' +
    'verify the affected project still builds and passes its relevant checks.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative file path' },
      content: { type: 'string', bulkArg: true, description: 'Full file content to write' },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description:
          'Leave it out to create a new file. Set it to "append" to add content to the end of a file, which is how ' +
          'a file too large to emit in one reply is written in stages: the first call creates it, each ' +
          'following call appends the next part.',
      },
    },
    required: ['path', 'content'],
  },
  wouldWrite(args) {
    return [{ path: String(args?.path ?? ''), after: () => (args?.mode === 'append' ? undefined : String(args?.content ?? '')) }];
  },
  // Re-typing a whole existing file to change part of it is where content gets lost, so existing files change only through edit_file, which names what it replaces.
  async cannotRun(args, ctx) {
    if (typeof args?.content !== 'string') return null;
    const bytes = Buffer.byteLength(args.content, 'utf8');
    if (bytes > MAX_BYTES) return fail(`Refusing to write ${bytes} bytes (limit ${MAX_BYTES})`, { code: TOOL_ERROR_CODE.ETOOLARGE });
    // An appended part is a fragment; execute checks the JSON the file ends up with.
    if (args?.mode === 'append') return null;
    if (isJsonPath(String(args.path ?? ''))) {
      const text = stripBom(args.content).text;
      if (text.trim() === '') {
        return fail(`Refusing to write ${args.path}: empty content is not valid JSON`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Write `{}` or `[]` for an empty document, or use json_patch to change one key.',
        });
      }
      const checked = validateJson(text, String(args.path));
      if (checked.ok === false) {
        const bad = checked as { error: string; hint: string };
        return fail(bad.error, { code: TOOL_ERROR_CODE.EINVAL, hint: bad.hint });
      }
    }
    let rel: string;
    try {
      const ws = workspaceFor(ctx);
      rel = ws.rel(ws.resolveLexical(String(args.path)));
    } catch {
      return null;
    }
    let before = '';
    try {
      const ws = workspaceFor(ctx);
      const abs = ws.resolveLexical(String(args.path));
      before = await fsp.readFile(abs, 'utf8');
    } catch {
      before = '';
    }
    if (before.trim() !== '') {
      const edits = before === args.content ? [] : equivalentEdits(before, args.content);
      if (edits?.length === 0) return fail(`Nothing was written — ${rel} already has exactly this content.`, { code: TOOL_ERROR_CODE.ESKIPPED });
      const call = edits ? `: ${JSON.stringify({ path: rel, edits })}` : ', copying each part you replace into search.';
      return fail(`Nothing was written — ${rel} already exists, and write_file only creates files or appends to them.`, {
        code: TOOL_ERROR_CODE.ESKIPPED,
        hint: `Change an existing file with edit_file, which names exactly what it replaces${call} To replace the whole file on purpose, delete it first and then create it.`,
      });
    }
    // Create path (absent or empty file): refuse content that does not parse,
    // before any approval prompt. Unknown extensions skip the check.
    const broken = await syntaxBreak(rel, before, String(args.content));
    if (broken) {
      return fail(`Refusing to write ${rel}: ${broken}. Nothing was written.`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Fix the content so the file still parses — the line number names the first new syntax error.',
      });
    }
    return null;
  },
  preview(args) {
    const content: string = typeof args?.content === 'string' ? args.content : '';
    const first = content.split('\n').find((l: string) => l.trim() !== '') ?? '';
    const head = first.trim().slice(0, 60);
    const verb = args?.mode === 'append' ? 'append to' : 'write';
    return `${verb} ${args?.path} (${content.length} chars)${head ? ` — ${head}${first.trim().length > 60 ? '…' : ''}` : ''}`;
  },

  async execute(args, ctx) {
    try {
      const abs = String(args.path);
      const rel = ctx.ws.rel(abs);

      const jsonFile = isJsonPath(rel);
      const coerced = coerceContent(args.content, jsonFile);
      if ('error' in coerced) return fail(coerced.error, { code: TOOL_ERROR_CODE.EINVAL });
      const incoming = coerced.text;
      const append = String(args.mode ?? '') === 'append';

      const before = await statType(abs);
      if (before?.type === 'dir') {
        return fail(`${rel} is a directory`, {
          code: TOOL_ERROR_CODE.EISDIR,
          hint: `Call list_directory on ${rel} to see the files inside it, then write to a file within — never to the directory path itself.`,
        });
      }

      // Read the previous content once so the size and JSON guards judge the bytes that will actually land.
      let oldContent = '';
      let hadBom = false;
      if (before?.type === 'file' || before?.type === 'symlink') {
        const opened = await openTextFile(abs, rel, {
          isDirHint: 'write_file works on files; use list_directory to inspect a directory.',
          binaryHint: 'Binary files cannot be overwritten by write_file.',
          notUtf8Error: `${rel} is not valid UTF-8 text and cannot be overwritten safely`,
          notUtf8Hint: 'Leave this file unchanged, or replace it only after converting it to UTF-8 text.',
        });
        if (!opened.ok) return opened.result;
        oldContent = opened.content;
        hadBom = opened.hadBom;
      }

      const text = append ? oldContent + incoming : incoming;

      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > MAX_BYTES) {
        return fail(`Refusing to write ${bytes} bytes (limit ${MAX_BYTES})`, { code: TOOL_ERROR_CODE.ETOOLARGE });
      }

      if (text === '' && !before && !path.extname(abs)) {
        return fail(`Refusing to create ${rel}: it has no file extension and no content`, {
          code: TOOL_ERROR_CODE.EISDIR_INTENT,
          hint: 'To create a directory use create_directory. To create a genuinely empty file, give it an extension.',
        });
      }

      if (jsonFile && text.trim() === '') {
        return fail(`Refusing to write ${rel}: empty content is not valid JSON`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Write `{}` or `[]` for an empty document, or use json_patch to change one key.',
        });
      }

      if (jsonFile) {
        const checked = validateJson(stripBom(text).text, rel);
        if (checked.ok === false) {
          const bad = (checked as { error: string; hint: string; });
          return fail(bad.error, { code: TOOL_ERROR_CODE.EINVAL, hint: bad.hint });
        }
      }

      if (text !== oldContent) {
        const broken = await syntaxBreak(rel, oldContent, text);
        if (broken) {
          return fail(`Refusing to write ${rel}: ${broken}. Nothing was written.`, {
            code: TOOL_ERROR_CODE.EINVAL,
            hint: 'Fix the content so the file still parses — the line number names the first new syntax error.',
          });
        }
      }

      const blocker = await findFileAncestor(ctx.root ?? ctx.cwd, abs);
      if (blocker) {
        const blockerRel = ctx.ws.rel(blocker);
        return fail(`Cannot write ${rel}: ${blockerRel} is a file, not a directory`, {
          code: TOOL_ERROR_CODE.ENOTDIR,
          hint: `Remove or rename ${blockerRel}, or use create_directory for the folders you need.`,
        });
      }

      const written = await writeAndVerify(abs, text, {
        hadBom,
        previousStat: before,
        expectedContent: before ? oldContent : null,
        // Only an overwrite has something to put back; a create must not leave an empty file behind when verification fails.
        original: before ? oldContent : null,
      });
      if (!written.ok) {
        return fail(
          `Tried to write ${rel} but the file is ${written.describe}.` +
            (written.restored ? ' The original content was put back.' : ''),
          {
            code: TOOL_ERROR_CODE.ENOTVERIFIED,
            hint: written.restored
              ? 'Nothing was changed. Re-read the file and try again.'
              : 'Re-read the file to see what state it is in before writing it again.',
          },
        );
      }

      const diff = safeDiff(before ? oldContent : null, text);
      // A write that leaves the file byte-identical did not change the workspace, so it must not
      // advance the mutation world. Counting it would invalidate every earlier result and make the
      // very same write look like fresh work on the next request.
      // `text` is what the file now holds: for an append it already starts with the old content.
      const changed = !before || text !== oldContent;
      if (changed) noteChange(ctx, before ? 'overwrite' : 'create', abs, 'file');
      const verb = before ? (append ? 'Appended to' : 'Overwrote') : 'Created';
      // "verified" now means the bytes were read back and matched, not merely that a stat found something at the path.
      const header = `${verb} ${rel} (${bytes} bytes) [verified: content read back]`;
      return ok({
        kind: 'file',
        display: diff ? `${header}\n${diff}` : header,
        data: {
          path: rel,
          bytes,
          appended: append,
          // Appending the same content again really does append again, so this request is not
          // interchangeable with a previous one and must not be answered from it.
          idempotent: !append,
          created: !before,
          existedBefore: Boolean(before),
          existsAfter: true,
          verified: true,
          diff,
          oldContent,
          newContent: text,
        },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

