import { TOOL_ERROR_CODE } from '../../protocol';

import { parseDocument, Document } from 'yaml';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { noteChange } from './_fs';
import { openTextFile, writeAndVerify, safeDiff } from './_text-file';
import { detectLineEnding } from './_match';
import { parsePointer, validatePointerSegments } from './json-patch.tool';

function isYamlPath(rel: string): boolean {
  return /\.ya?ml$/i.test(String(rel ?? ''));
}

type YamlPath = (string | number)[];

/** Numeric segments address sequences; anything else addresses mappings. */
function toYamlPath(segs: string[]): YamlPath {
  return segs.map((s) => (/^(0|[1-9]\d*)$/.test(s) ? Number(s) : s));
}

export type YamlPatchDry =
  | { status: 'get'; value: unknown }
  | { status: 'ok'; text: string; rootReplaced: boolean }
  | { status: 'fail'; note: string; hint?: string; code: import('../../protocol.ts').ToolErrorCode };

/** Everything yaml_patch decides before touching disk, shared so the approval preview matches the real result. */
export function dryRunYamlPatch(source: string, args: Record<string, any>, rel: string): YamlPatchDry {
  const op = String(args.op ?? 'get');

  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    const first = doc.errors[0];
    const headline = String(first.message ?? first).split('\n')[0];
    const at = first.linePos?.[0];
    const located = at && !/line \d+/.test(headline) ? ` at line ${at.line}, column ${at.col}` : '';
    return {
      status: 'fail',
      note: `Refusing ${rel}: existing content is invalid YAML (${headline}${located}). Nothing was written.`,
      hint: 'Fix the file with edit_file first, then retry yaml_patch.',
      code: TOOL_ERROR_CODE.EINVAL,
    };
  }

  const segs = parsePointer(String(args.pointer ?? ''));
  const unsafePointer = validatePointerSegments(segs);
  if (unsafePointer) {
    return { status: 'fail', note: unsafePointer, code: TOOL_ERROR_CODE.EINVAL };
  }
  const path = toYamlPath(segs);

  if (op !== 'get' && op !== 'set' && op !== 'remove') {
    return { status: 'fail', note: `op must be get, set, or remove`, code: TOOL_ERROR_CODE.EINVAL };
  }

  const ending = detectLineEnding(source);
  const withEnding = (text: string) => (ending === 'crlf' ? text.replace(/(?<!\r)\n/g, '\r\n') : text);

  if (op === 'get') {
    if (segs.length === 0) return { status: 'get', value: doc.toJS() };
    if (!doc.hasIn(path)) {
      return {
        status: 'fail',
        note: `key "${segs[segs.length - 1]}" does not exist in ${rel}`,
        hint: 'Use op=set to create it, or read the file to see available keys.',
        code: TOOL_ERROR_CODE.ENOMATCH,
      };
    }
    return { status: 'get', value: doc.getIn(path) };
  }

  if (segs.length === 0) {
    if (op === 'remove') {
      return { status: 'fail', note: 'refusing to remove the document root', code: TOOL_ERROR_CODE.EINVAL };
    }
    if (args.value === undefined) return { status: 'fail', note: 'value is required for set', code: TOOL_ERROR_CODE.EINVAL };
    return { status: 'ok', text: withEnding(new Document(args.value as unknown).toString()), rootReplaced: true };
  }

  try {
    if (op === 'remove') {
      if (!doc.hasIn(path)) {
        return { status: 'fail', note: `key "${segs[segs.length - 1]}" does not exist`, code: TOOL_ERROR_CODE.ENOMATCH };
      }
      doc.deleteIn(path);
    } else {
      if (args.value === undefined) return { status: 'fail', note: 'value is required for set', code: TOOL_ERROR_CODE.EINVAL };
      doc.setIn(path, args.value as unknown);
    }
  } catch (err) {
    return {
      status: 'fail',
      note: `Refusing to write ${rel}: ${(err as Error).message}. Nothing was written.`,
      code: TOOL_ERROR_CODE.EUNKNOWN,
    };
  }

  if (doc.errors.length > 0) {
    return { status: 'fail', note: `Refusing to write ${rel}: result is invalid YAML. Nothing was written.`, code: TOOL_ERROR_CODE.EUNKNOWN };
  }
  let text = withEnding(doc.toString());
  if (!source.endsWith('\n') && text.endsWith('\n')) text = text.slice(0, -1);
  return { status: 'ok', text, rootReplaced: false };
}

export default defineTool({
  name: 'yaml_patch',
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Patching YAML',
  label: 'YAML Patch',
  brief: 'Get or set a value in a .yaml/.yml file by key path (e.g. pointer "/server/port"). Keeps comments.',
  risky: true,
  restorable: true,
  description:
    'Read or change one value inside a YAML file by key pointer, without quoting the whole file. ' +
    'Pointer forms: "/a/0/b", "a.b.0", "a/b/c". `op` is get, set, or remove. For set, pass `value` as real data ' +
    '(object/array/number/boolean/string). Comments and ordering are preserved; the file is validated before and after; nothing is written when invalid.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative .yaml/.yml file path' },
      op: { type: 'string', description: 'get, set, or remove', enum: ['get', 'set', 'remove'] },
      pointer: { type: 'string', description: 'Key pointer, e.g. "/server/port" or "server.port"' },
      value: { type: 'any', description: 'New value for set (any JSON-like type)' },
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
      if (!isYamlPath(rel)) {
        return fail(`${rel} is not a .yaml/.yml file`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'yaml_patch works on YAML files; use edit_file for other text, json_patch for .json.',
        });
      }
      const opened = await openTextFile(abs, rel, {
        isDirHint: 'yaml_patch works on files; use list_directory to inspect a directory.',
        notUtf8Error: `${rel} is not valid UTF-8 text`,
      });
      if (!opened.ok) return opened.result;
      const source = opened.content;

      const dry = dryRunYamlPatch(source, args, rel);
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
        return ok({ kind: 'file', display: `Set ${rel} (document root replaced)`, data: { path: rel, pointer: '', value: args.value } });
      }
      const diff = safeDiff(source, text, { maxLines: 40 });
      const header = `${args.op === 'set' ? 'Set' : 'Removed'} ${rel}${args.pointer ? ` ${args.pointer}` : ''}`;
      return ok({
        kind: 'file',
        display: diff ? `${header}\n${diff}` : header,
        data: { path: rel, pointer: String(args.pointer ?? ''), op: args.op, diff, oldContent: source, newContent: text },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});
