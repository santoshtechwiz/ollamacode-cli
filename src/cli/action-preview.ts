import fsp from 'node:fs/promises';
import path from 'node:path';

import { countLines } from '../tool/filesystem/_match';
import { isBinaryExtension, decodeUtf8 } from '../tool/filesystem/_fs';
import { isProtectedPid, listeningPids, describeProcess } from '../tool/process/processes/discovery';
import { dryRunEdit } from '../tool/filesystem/edit-file.tool';
import type { EditArgs } from '../tool/filesystem/edit-file.tool';
import { renderDiff, renderNewFile } from '../ui/diff';
import { FOLDER_UNDO_MAX_FILES, hasMoreFilesThan, readRecovery, sessionHasLedger } from '../core/session-recovery';
import { PREVIEWABLE_TOOLS } from '../protocol';

const MAX_DIFF_LINES = 30;

const MAX_PREVIEW_BYTES = 512 * 1024;

interface ActionPreview {
  verb: string;
  target: string;
  lines: string[];
  note?: string;
}

export function isPreviewable(name: string): boolean {
  return PREVIEWABLE_TOOLS.has(String(name));
}

export function previewQuestion(action: ActionPreview): string {
  return `${action.verb} ${action.target}${action.note ? ` — ${action.note}` : ''}`;
}

export async function describeAction(name: string, args: Record<string, any>, { cwd, maxLines = MAX_DIFF_LINES, root, sessionId }: any): Promise<ActionPreview | null> {
  if (!isPreviewable(name)) return null;
  if (name === 'stop_process') return await previewStop(args);
  if (name === 'undo') return await previewUndo(args, { root, sessionId, cwd });
  const target = String(args?.path ?? '').trim();
  if (!target) return null;
  const abs = path.resolve(cwd, target);

  try {
    if (name === 'delete_file') return await previewDelete(abs, target, args, sessionHasLedger(sessionId));
    if (name === 'write_file') return await previewWrite(abs, target, args, maxLines);
    if (name === 'edit_file') return await previewEdit(abs, target, args, maxLines);
  } catch (err) {
    return { verb: 'change', target, lines: [], note: `could not preview: ${describeErr(err)}` };
  }
  return null;
}

async function previewUndo(args: Record<string, any>, opts: { root?: string; sessionId?: string; cwd?: string; }): Promise<ActionPreview> {
  const relArg = String(args?.path ?? '').trim();
  if (!opts.root || !sessionHasLedger(opts.sessionId)) {
    return {
      verb: 'undo',
      target: relArg || 'most recent file change',
      lines: [],
      note: 'no recovery ledger is attached to this call',
    };
  }
  let entries = [];
  try {
    entries = await readRecovery(opts.root, opts.sessionId);
  } catch {
    return { verb: 'undo', target: relArg || 'most recent file change', lines: [], note: 'could not read the recovery ledger' };
  }
  let target: string | null = null;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (!relArg || entries[i].rel === relArg) {
      target = entries[i].rel;
      break;
    }
  }
  if (!target) {
    return { verb: 'undo', target: relArg || 'most recent file change', lines: [], note: 'no recorded change to undo' };
  }
  return {
    verb: 'undo',
    target,
    lines: [],
    note: 'restores the bytes the file had before the session changed it (or removes a file it created)',
  };
}

async function previewStop(args: Record<string, any>): Promise<ActionPreview> {
  try {
    const hasPort = args?.port !== undefined && args.port !== null && String(args.port) !== '';
    const hasPid = args?.pid !== undefined && args.pid !== null && String(args.pid) !== '';
    if (hasPort) {
      const port = Math.floor(Number(args.port));
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return { verb: 'stop', target: `port ${String(args.port)}`, lines: [], note: 'not a valid port — the call will fail' };
      }
      const pids = await listeningPids(port);
      if (pids.length === 0) {
        return { verb: 'stop', target: `port ${port}`, lines: [], note: 'nothing is listening there — the call will fail' };
      }
      const names: any[] = [];
      for (const pid of pids.slice(0, 3)) {
        const d = await describeProcess(pid).catch((): null => null);
        names.push(d ? `${d.image} (PID ${pid})` : `PID ${pid}`);
      }
      const more = pids.length > 3 ? `, +${pids.length - 3} more` : '';
      return {
        verb: 'stop',
        target: `port ${port} — ${names.join(', ')}${more}`,
        lines: [],
        note: pids.some(isProtectedPid) ? 'a protected process holds this port — the call will fail' : 'this is not undoable',
      };
    }
    if (hasPid) {
      const pid = Math.floor(Number(args.pid));
      if (!Number.isInteger(pid) || pid <= 0) {
        return { verb: 'stop', target: `PID ${String(args.pid)}`, lines: [], note: 'not a valid pid — the call will fail' };
      }
      if (isProtectedPid(pid)) {
        return { verb: 'stop', target: `PID ${pid}`, lines: [], note: 'a protected process — the call will fail' };
      }
      const d = await describeProcess(pid).catch((): null => null);
      return {
        verb: 'stop',
        target: d ? `${d.image} (PID ${pid})` : `PID ${pid}`,
        lines: [],
        note: d ? 'this is not undoable' : 'no such process right now — the call will fail',
      };
    }
    return { verb: 'stop', target: 'no target', lines: [], note: 'give exactly one of pid or port — the call will fail' };
  } catch (err) {
    return { verb: 'stop', target: 'process', lines: [], note: `could not resolve target: ${describeErr(err)}` };
  }
}

/** A delete in a session with a recovery ledger is saved first and /undo brings it back; without one it is gone. */
async function previewDelete(abs: string, target: string, args: Record<string, any>, undoable = false): Promise<ActionPreview> {
  const after = undoable ? '/undo can bring it back' : 'this is not undoable';
  const stat = await fsp.stat(abs).catch((): null => null);
  if (!stat) return { verb: 'delete', target, lines: [], note: 'no such path — the call will fail' };
  if (stat.isDirectory()) {
    const entries = await fsp.readdir(abs).catch((): string[] => []);
    const count = `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} inside`;
    if (entries.length === 0) {
      return { verb: 'delete directory', target, lines: [], note: 'the directory is empty' };
    }
    // A folder too big to save first (a node_modules) is deleted in one go: the question says so before the yes.
    const folderAfter = undoable && args?.recursive === true && await hasMoreFilesThan(abs, FOLDER_UNDO_MAX_FILES)
      ? `more than ${FOLDER_UNDO_MAX_FILES} files, too many to save first — /undo cannot bring it back`
      : after;
    return {
      verb: 'delete directory',
      target,
      lines: [],
      note: args?.recursive === true
        ? `${count}, and recursive is set — all of it goes; ${folderAfter}`
        : `${count}, and recursive is not set — the call will fail`,
    };
  }
  const read = await readText(abs, stat.size);
  return {
    verb: 'delete',
    target,
    lines: [],
    note: read.text === null
      ? `${stat.size} bytes — ${after}`
      : `${countLines(read.text)} lines, ${stat.size} bytes — ${after}`,
  };
}

async function previewWrite(abs: string, target: string, args: Record<string, any>, maxLines: number): Promise<ActionPreview> {
  const content = typeof args?.content === 'string' ? args.content : '';
  const stat = await fsp.stat(abs).catch((): null => null);
  if (stat?.isDirectory()) {
    return { verb: 'write', target, lines: [], note: 'the path is a directory — the call will fail' };
  }
  if (!stat || !stat.isFile()) {
    return { verb: 'create', target, lines: clampBody(renderNewFile(content), maxLines) };
  }
  const read = await readText(abs, stat.size);
  if (read.why !== null || read.text === null) {
    return { verb: 'overwrite', target, lines: [], note: `replaces ${stat.size} bytes on disk` };
  }
  const before = read.text;
  if (before === content) {
    return { verb: 'overwrite', target, lines: [], note: 'identical to what is already on disk' };
  }
  return {
    verb: 'overwrite',
    target,
    lines: clampBody(renderDiff(before, content, { context: 2, maxLines }), maxLines),
  };
}

/** Read the file a preview is about, or the reason there is nothing to show. */
async function openForPreview(
  abs: string,
  target: string,
  verb: string
): Promise<{ before: string; refusal?: undefined } | { before?: undefined; refusal: ActionPreview }> {
  const stat = await fsp.stat(abs).catch((): null => null);
  if (stat?.isDirectory()) {
    return { refusal: { verb, target, lines: [], note: 'the path is a directory — the call will fail' } };
  }
  if (!stat || !stat.isFile()) {
    return { refusal: { verb, target, lines: [], note: 'no such file — the call will fail' } };
  }
  const read = await readText(abs, stat.size);
  if (read.why !== null || read.text === null) {
    const note = read.why === 'too-large'
      ? `file is ${stat.size} bytes — too large to preview`
      : read.why === 'unreadable'
        ? 'the file could not be read to preview it'
        : read.why === 'binary'
          ? 'the file is binary — the call will fail'
          : 'the file is not valid UTF-8 text — the call will fail';
    return { refusal: { verb, target, lines: [], note } };
  }
  return { before: read.text };
}

async function previewEdit(abs: string, target: string, args: Record<string, any>, maxLines: number): Promise<ActionPreview> {
  const opened = await openForPreview(abs, target, 'edit');
  if (opened.refusal) return opened.refusal;
  const before = opened.before;
  const outcome = dryRunEdit(before, args as EditArgs, target, target.toLowerCase().endsWith('.json'));
  if (outcome.status === 'fail') {
    return { verb: 'edit', target, lines: [], note: `${outcome.result.error} — the call will fail` };
  }
  if (outcome.content === before) return { verb: 'edit', target, lines: [], note: 'this edit changes nothing' };
  return {
    verb: 'edit',
    target,
    lines: clampBody(renderDiff(before, outcome.content, { context: 2, maxLines }), maxLines),
  };
}


async function readText(abs: string, size: number): Promise<{ text: string | null; why: 'too-large' | 'unreadable' | 'binary' | 'not-utf8' | null; }> {
  if (size > MAX_PREVIEW_BYTES) return { text: null, why: 'too-large' };
  const buf = await fsp.readFile(abs).catch((): null => null);
  if (!buf) return { text: null, why: 'unreadable' };
  if (buf.subarray(0, 4096).includes(0)) return { text: null, why: 'binary' };
  const decoded = decodeUtf8(buf);
  const why = isBinaryExtension(abs) ? 'binary' : decoded.lossless ? null : 'not-utf8';
  return { text: decoded.text, why };
}

function clampBody(body: string, maxLines: number): string[] {
  const lines = String(body ?? '').split('\n').filter((l) => l.length > 0);
  if (lines.length <= maxLines + 1) return lines;
  return [...lines.slice(0, maxLines + 1), `  … ${lines.length - maxLines - 1} more lines`];
}

function describeErr(err: unknown): string {
  const e = (err as any);
  return String(e?.code ?? e?.message ?? err);
}
