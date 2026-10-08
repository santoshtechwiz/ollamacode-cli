import { TOOL_ERROR_CODE } from '../../protocol';
import path from 'node:path';
import fsp from 'node:fs/promises';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { statType, noteChange, findFileAncestor } from './_fs';
import { openTextFile, writeAndVerify, safeDiff } from './_text-file';
import { syntaxBreak } from './_syntax';
import { isJsonPath, validateJson, stripBom } from './_json';
import { workspaceFor } from '../../agent/workspace/manager';
import { noteSeen, hasSeen } from './_seen';

export const MAX_BYTES = 5 * 1024 * 1024;

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
  brief: 'Create a UTF-8 text file, replace one you have read, or append to one. Ensures the directory exists.',
  risky: true,
  restorable: true,
  description:
    'Write the whole content of a file: create it, or replace an existing file you have read this session. To change ' +
    'part of a file, use edit_file, which leaves the rest untouched. Append with mode="append"; a file too large to ' +
    'emit in one reply is written in stages: one call to write it, then mode="append" for each following part. After ' +
    'writing, verify the affected project still builds and passes its relevant checks.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative file path' },
      content: { type: 'string', bulkArg: true, description: 'Full file content to write' },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description:
          'Leave it out to write the whole file. Set it to "append" to add content to the end of a file, which is how ' +
          'a file too large to emit in one reply is written in stages: the first call creates it, each ' +
          'following call appends the next part.',
      },
    },
    required: ['path', 'content'],
  },
  wouldWrite(args) {
    return [{ path: String(args?.path ?? ''), after: () => (args?.mode === 'append' ? undefined : String(args?.content ?? '')) }];
  },
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
      if (before === args.content) return fail(`Nothing was written — ${rel} already has exactly this content.`, { code: TOOL_ERROR_CODE.ESKIPPED });
      // Replacing a file means writing over what it holds: only a file the model has read, so it is not written from memory.
      if (!hasSeen(ctx?.state, rel)) {
        return fail(`${rel} already exists and has not been read in this session — nothing was written.`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: `Read ${rel} with read_file first; then write its new content, or change part of it with edit_file.`,
        });
      }
    }
    // Refuse content that does not parse, before any approval prompt; only errors this write adds count.
    // Unknown extensions skip the check.
    const broken = await syntaxBreak(rel, before, String(args.content));
    if (broken) {
      return {
        ...fail(`Refusing to write ${rel}: ${broken.why}. Nothing was written.`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Fix the content so the file still parses — the line number names the first new syntax error.',
        }),
        modelNote: `The content around that line (> marks the error):\n${broken.context}`,
      };
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
      // A write that leaves the file byte-identical did not change the workspace.
      // `text` is what the file now holds: for an append it already starts with the old content.
      const changed = !before || text !== oldContent;
      if (changed) noteChange(ctx, before ? 'overwrite' : 'create', abs, 'file');
      // The model wrote this text, so it has seen the file: an edit may follow without a read.
      noteSeen(ctx?.state, workspaceFor(ctx).rel(abs), text);
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

