import { TOOL_ERROR_CODE } from '../../protocol';

import { parseTree, findNodeAtLocation, getNodeValue, modify, applyEdits } from 'jsonc-parser';
import type { Node as JsonNode, ParseError as JsonParseError } from 'jsonc-parser';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { noteChange } from './_fs';
import { openTextFile, writeAndVerify, safeDiff } from './_text-file';
import { detectJsonIndent } from './_json';
import { detectLineEnding } from './_match';

/** Shared with yaml_patch: pointer forms "/a/0/b", "a.b.0", "a/b/c". */
export function parsePointer(pointer: string): string[] {  const raw = String(pointer ?? '').trim();
  if (!raw || raw === '/' || raw === '.') return [];
  if (raw.startsWith('/')) {
    return raw
      .split('/')
      .slice(1)
      .map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return raw.split(/[./]/).filter(Boolean);
}

const UNSAFE_POINTER_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Shared with yaml_patch: prototype-pollution segments can never be addressed. */
export function validatePointerSegments(segs: string[]): string | null {
  const unsafe = segs.find((seg) => UNSAFE_POINTER_SEGMENTS.has(seg));
  return unsafe ? `pointer segment "${unsafe}" is reserved and cannot be changed` : null;
}

export type JsonPatchDry =
  | { status: 'get'; value: unknown }
  | { status: 'ok'; text: string; rootReplaced: boolean; value?: unknown }
  | { status: 'fail'; note: string; hint?: string; code: import('../../protocol.ts').ToolErrorCode };

type JsonPath = (string | number)[];

function parseTolerant(source: string): { root: JsonNode | undefined; errors: number } {
  const errors: JsonParseError[] = [];
  const root = parseTree(source, errors, { allowTrailingComma: true });
  return { root, errors: errors.length };
}

/**
 * Walk the parsed tree typing each segment (numbers for arrays), so `modify`
 * — which throws on numeric strings, silently appends past array ends, and
 * no-ops (or worse) on missing remove targets — never sees an unvalidated
 * path. Missing nodes stay undefined for `set` to create; anything else
 * fails here with the same errors the old engine gave.
 */
function locate(
  root: JsonNode | undefined,
  segs: string[],
  pointer: string,
  forCreate: boolean,
):
  | { status: 'ok'; path: JsonPath; node: JsonNode | undefined }
  | { status: 'fail'; note: string; missing?: string } {
  const path: JsonPath = [];
  let node = root;
  let firstMissing: string | null = null;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (node === undefined) {
      if (!forCreate) {
        const missing = firstMissing ?? seg;
        return { status: 'fail', note: `key "${missing}" does not exist`, missing };
      }
      path.push(seg);
      continue;
    }
    if (node.type === 'array') {
      const kids = node.children ?? [];
      if (forCreate && (seg === '-' || seg === '')) {
        path.push(kids.length);
        node = undefined;
        continue;
      }
      const idx = Number(seg);
      if (!Number.isInteger(idx) || idx < 0 || idx > kids.length || (!forCreate && idx >= kids.length)) {
        return { status: 'fail', note: `pointer "${pointer}" is out of range (array length ${kids.length})` };
      }
      path.push(idx);
      if (idx >= kids.length) {
        node = undefined;
      } else {
        node = kids[idx];
      }
      if (node === undefined && firstMissing === null) firstMissing = seg;
      continue;
    }
    if (node.type === 'object') {
      path.push(seg);
      node = findNodeAtLocation(root!, [...path]);
      if (node === undefined && firstMissing === null) firstMissing = seg;
      continue;
    }
    return { status: 'fail', note: `cannot descend into ${typeof getNodeValue(node)} at "${segs.slice(0, i + 1).join('/')}"` };
  }
  return { status: 'ok', path, node };
}

/** Everything json_patch decides before touching disk, shared so the approval preview matches the real result. */
export function dryRunJsonPatch(source: string, args: Record<string, any>, rel: string): JsonPatchDry {
  const op = String(args.op ?? 'get');

  // Tolerant: comments and trailing commas survive (tsconfig.json works now).
  // modify() mangles broken input without throwing, so refuse up front.
  const parsed = parseTolerant(source);
  if (parsed.errors > 0 || parsed.root === undefined) {
    return {
      status: 'fail',
      note: `Refusing ${rel}: existing content is invalid JSON (${parsed.errors} syntax error(s)). Nothing was written.`,
      hint: 'Fix the file with edit_file first, then retry json_patch.',
      code: TOOL_ERROR_CODE.EINVAL,
    };
  }
  const root = parsed.root;

  const segs = parsePointer(String(args.pointer ?? ''));
  const unsafePointer = validatePointerSegments(segs);
  if (unsafePointer) {
    return { status: 'fail', note: unsafePointer, code: TOOL_ERROR_CODE.EINVAL };
  }

  if (op !== 'get' && op !== 'set' && op !== 'remove') {
    return { status: 'fail', note: `op must be get, set, or remove`, code: TOOL_ERROR_CODE.EINVAL };
  }

  if (op === 'get') {
    const found = locate(root, segs, String(args.pointer ?? ''), false);
    if (found.status === 'fail') {
      if (found.missing) {
        return {
          status: 'fail',
          note: `key "${found.missing}" does not exist in ${rel}`,
          hint: 'Use op=set to create it, or read the file to see available keys.',
          code: TOOL_ERROR_CODE.ENOMATCH,
        };
      }
      return { status: 'fail', note: found.note, code: TOOL_ERROR_CODE.ENOMATCH };
    }
    if (found.node === undefined) {
      const last = segs[segs.length - 1] ?? '';
      return {
        status: 'fail',
        note: `key "${last}" does not exist in ${rel}`,
        hint: 'Use op=set to create it, or read the file to see available keys.',
        code: TOOL_ERROR_CODE.ENOMATCH,
      };
    }
    return { status: 'get', value: getNodeValue(found.node) };
  }

  const indent = detectJsonIndent(source) || '  ';
  const ending = detectLineEnding(source);
  const withEnding = (text: string) => (ending === 'crlf' ? text.replace(/(?<!\r)\n/g, '\r\n') : text);
  const formattingOptions = {
    tabSize: indent === '\t' ? 4 : indent.length,
    insertSpaces: indent !== '\t',
    eol: ending === 'crlf' ? '\r\n' : '\n',
  };

  if (segs.length === 0) {
    if (op === 'remove') {
      return { status: 'fail', note: 'refusing to remove the document root', code: TOOL_ERROR_CODE.EINVAL };
    }
    if (args.value === undefined) return { status: 'fail', note: 'value is required for set', code: TOOL_ERROR_CODE.EINVAL };
    const newRoot = args.value;
    return {
      status: 'ok',
      rootReplaced: true,
      value: newRoot,
      text: `${withEnding(JSON.stringify(newRoot, null, indent))}\n`,
    };
  }

  if (op === 'remove') {
    const found = locate(root, segs, String(args.pointer ?? ''), false);
    if (found.status === 'fail') return { status: 'fail', note: found.note, code: TOOL_ERROR_CODE.ENOMATCH };
    if (found.node === undefined) {
      return { status: 'fail', note: `key "${segs[segs.length - 1]}" does not exist`, code: TOOL_ERROR_CODE.ENOMATCH };
    }
    let text: string;
    try {
      text = applyEdits(source, modify(source, found.path, undefined, {}));
    } catch (err) {
      return { status: 'fail', note: `Refusing to write ${rel}: ${(err as Error).message}. Nothing was written.`, code: TOOL_ERROR_CODE.EUNKNOWN };
    }
    if (parseTolerant(text).errors > 0) {
      return { status: 'fail', note: `Refusing to write ${rel}: result is invalid JSON. Nothing was written.`, code: TOOL_ERROR_CODE.EUNKNOWN };
    }
    return { status: 'ok', text, rootReplaced: false };
  }

  if (args.value === undefined) return { status: 'fail', note: 'value is required for set', code: TOOL_ERROR_CODE.EINVAL };
  const found = locate(root, segs, String(args.pointer ?? ''), true);
  if (found.status === 'fail') return { status: 'fail', note: found.note, code: TOOL_ERROR_CODE.ENOMATCH };
  let text: string;
  try {
    text = applyEdits(source, modify(source, found.path, args.value as unknown, { formattingOptions }));
  } catch (err) {
    return { status: 'fail', note: `Refusing to write ${rel}: ${(err as Error).message}. Nothing was written.`, code: TOOL_ERROR_CODE.EUNKNOWN };
  }
  if (parseTolerant(text).errors > 0) {
    return { status: 'fail', note: `Refusing to write ${rel}: result is invalid JSON. Nothing was written.`, code: TOOL_ERROR_CODE.EUNKNOWN };
  }
  return { status: 'ok', text, rootReplaced: false };
}

export default defineTool({
  name: 'json_patch',
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Patching JSON',
  label: 'JSON Patch',
  brief: 'Get or set a value in a .json file by key path (e.g. pointer "/scripts/test"). Validates JSON.',
  risky: true,
  restorable: true,
  description:
    'Read or change one value inside a JSON file by key pointer, without quoting the whole file. ' +
    'Pointer forms: "/a/0/b", "a.b.0", "a/b/c". `op` is get, set, or remove. For set, pass `value` as real JSON (object/array/number/boolean/string) — it is stringified with the file\'s own indent. The file is validated before and after; nothing is written when invalid.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative .json file path' },
      op: { type: 'string', description: 'get, set, or remove', enum: ['get', 'set', 'remove'] },
      pointer: { type: 'string', description: 'Key pointer, e.g. "/dependencies/react" or "scripts.test"' },
      value: { type: 'any', description: 'New value for set (any JSON type)' },
    },
    required: ['path', 'op'],
  },
  preview(args) {
    const ptr = args?.pointer ? ` ${args.pointer}` : '';
    if (args?.op === 'get') return `read ${args?.path}${ptr}`;
    if (args?.op === 'remove') return `remove ${args?.path}${ptr}`;
    let v = '';
    try {
      const s = JSON.stringify(args?.value);
      v = s.length > 50 ? `${s.slice(0, 49)}…` : s;
    } catch {
      v = '(value)';
    }
    return `set ${args?.path}${ptr} = ${v}`;
  },
  async execute(args, ctx) {
    try {
      const abs = String(args.path);
      const rel = ctx.ws.rel(abs);
      if (!rel.toLowerCase().endsWith('.json')) {
        return fail(`${rel} is not a .json file`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'json_patch works on .json files; use edit_file for other text.',
        });
      }
      const op = String(args.op ?? 'get');
      if (!['get', 'set', 'remove'].includes(op)) {
        return fail(`op must be get, set, or remove`, { code: TOOL_ERROR_CODE.EINVAL });
      }
      const opened = await openTextFile(abs, rel, {
        isDirHint: 'json_patch works on files; use list_directory to inspect a directory.',
        notUtf8Error: `${rel} is not valid UTF-8 text`,
      });
      if (!opened.ok) return opened.result;
      const source = opened.content;

      const dry = dryRunJsonPatch(source, args, rel);
      if (dry.status === 'fail') {
        return fail(dry.note, { code: dry.code, hint: dry.hint });
      }
      if (dry.status === 'get') {
        const display = typeof dry.value === 'string' ? dry.value : JSON.stringify(dry.value, null, 2);
        return ok({
          kind: 'file',
          display: `${rel}${args.pointer ? ` ${args.pointer}` : ''} = ${display}`,
          data: { path: rel, pointer: String(args.pointer ?? ''), value: dry.value },
        });
      }

      const text = dry.text;
      // Verified before the change is journalled, and on every branch: the root-replacement path used to return without checking anything at all.
      const written = await writeAndVerify(abs, text, {
        hadBom: opened.hadBom,
        previousStat: opened.stat,
        original: source,
        expectedContent: source,
      });
      if (!written.ok) {
        return fail(
          `Tried to patch ${rel} but the file is ${written.describe} afterwards.` +
            (written.restored ? ' The original content was put back.' : ''),
          {
            code: TOOL_ERROR_CODE.ENOTVERIFIED,
            hint: written.restored
              ? 'Nothing was changed. Re-read the file and try again.'
              : 'Re-read the file to see what state it is in before patching it again.',
          },
        );
      }
      noteChange(ctx, 'edit', abs, 'file');

      if (dry.rootReplaced) {
        return ok({ kind: 'file', display: `Set ${rel} (document root replaced)`, data: { path: rel, pointer: '', value: dry.value } });
      }
      const diff = safeDiff(source, text, { maxLines: 40 });
      const header = `${op === 'set' ? 'Set' : 'Removed'} ${rel}${args.pointer ? ` ${args.pointer}` : ''}`;
      return ok({
        kind: 'file',
        display: diff ? `${header}\n${diff}` : header,
        data: { path: rel, pointer: String(args.pointer ?? ''), op, diff, oldContent: source, newContent: text },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

