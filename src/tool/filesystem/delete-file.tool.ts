import fsp from 'node:fs/promises';

import { TOOL_ERROR_CODE, TOOL_RESULT_STATUS } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { statType, noteChange } from './_fs';
import { hasSeen } from './_seen';
import { workspaceFor } from '../../agent/workspace/manager';
import { FOLDER_UNDO_MAX_FILES, hasMoreFilesThan, snapshotPaths } from '../../core/session-recovery';

/** How much of a file is looked at to tell text from binary. */
const SNIFF_BYTES = 8192;

export default defineTool({
  name: 'delete_file',
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Deleting a file',
  label: 'Delete',
  brief: 'Delete a file, or a directory with recursive:true. Never on review-finding alone: trace the file\'s references and verify the affected project first.',
  risky: true,
  restorable: true,
  confirmReason: () => 'deletes files',
  description:
    'Delete a file, or a directory with recursive:true. Refuses the workspace root and non-empty directories unless recursive is set. ' +
    'If the path is already gone, the result is NOT_FOUND with existedBefore:false — never a claimed deletion. ' +
    'A text file with content must be read in this session first. Check nothing still references it, and afterwards verify the project still builds.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative file or directory to delete' },
      recursive: {
        type: 'boolean',
        description: 'Required to delete a directory that is not empty. Deletes everything beneath it.',
      },
    },
    required: ['path'],
  },

  wouldWrite(args) {
    return [{ path: String(args?.path ?? ''), after: () => null }];
  },

  preview(args) {
    return `delete ${args?.path}${args?.recursive ? ' (recursive)' : ''}`;
  },

  // A text file with content is deleted only once the model has read it, as write_file overwrites one: refused before
  // any approval prompt, so the person is never asked about a delete made without looking.
  async cannotRun(args, ctx) {
    let abs: string;
    let rel: string;
    try {
      const ws = workspaceFor(ctx);
      abs = ws.resolveLexical(String(args?.path ?? ''));
      rel = ws.rel(abs);
    } catch {
      return null;
    }
    if (hasSeen(ctx?.state, rel) || (await statType(abs))?.type !== 'file') return null;
    let head: Buffer;
    try {
      const handle = await fsp.open(abs, 'r');
      try {
        const { buffer, bytesRead } = await handle.read(Buffer.alloc(SNIFF_BYTES), 0, SNIFF_BYTES, 0);
        head = buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
    // Binary files (images, fonts) have nothing read_file could show, and an empty file nothing to lose.
    if (head.includes(0) || head.toString('utf8').trim() === '') return null;
    return fail(`${rel} has not been read in this session — nothing was deleted.`, {
      code: TOOL_ERROR_CODE.EINVAL,
      hint: `Read ${rel} with read_file first and check nothing still uses it. A file that is only no longer needed can stay.`,
    });
  },

  async execute(args, ctx) {
    try {
      const abs = String(args.path);
      const rel = ctx.ws.rel(abs);

      if (abs === ctx.ws.root || rel === '.') {
        return fail('Refusing to delete the workspace root', {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Delete the specific files or subdirectories you mean.',
        });
      }
      if (/(^|\/)\.git(\/|$)/.test(rel)) {
        return fail(`Refusing to delete ${rel}: that is the git repository itself`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Use the git tool to discard changes rather than deleting repository internals.',
        });
      }

      const found = await statType(abs);
      let saved: { snapshotted: number; unrestorable: number } | null = null;
      let tooBig = false;
      if (!found) {
        return fail(`${rel} does not exist — nothing to delete`, {
          code: TOOL_ERROR_CODE.ENOENT,
          display: `${rel} does not exist — nothing to delete`,
          status: TOOL_RESULT_STATUS.NOT_FOUND,
          hint: 'Report it as not found rather than claiming the deletion. If the target lives elsewhere, use the actual path.',
          data: { path: rel, deleted: false, existedBefore: false, existsAfter: false, verified: true, type: null },
        });
      }

      if (found.type === 'dir') {
        const entries = await fsp.readdir(abs);
        if (entries.length > 0 && args.recursive !== true) {
          return fail(`${rel} is a directory with ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`, {
            code: TOOL_ERROR_CODE.EISDIR,
            hint: 'Pass recursive:true to delete it and everything inside it.',
          });
        }
        // A file's bytes are saved by the runtime before any restorable call; a folder's files are saved here, the way a
        // shell delete's are, so /undo brings the whole folder back.
        tooBig = entries.length > 0 && await hasMoreFilesThan(abs, FOLDER_UNDO_MAX_FILES);
        saved = entries.length > 0 && !tooBig ? await snapshotPaths({ root: ctx.ws.root, sessionId: ctx.state?.sessionId, tool: 'delete_file', targets: [abs] }) : null;
        await fsp.rm(abs, { recursive: true, force: true });
      } else {
        await fsp.rm(abs, { force: true });
      }

      if (await statType(abs)) {
        return fail(`${rel} still exists after the delete`, {
          code: TOOL_ERROR_CODE.EPERM,
          status: TOOL_RESULT_STATUS.NOT_VERIFIED,
          hint: 'Something is holding the path open, or permissions prevent removal.',
          data: { path: rel, deleted: false, existedBefore: true, existsAfter: true, verified: false, type: found.type },
        });
      }

      noteChange(ctx, 'delete', abs, found.type === 'dir' ? 'dir' : 'file');
      return ok({
        kind: 'status',
        display: `Deleted ${rel}${found.type === 'dir' ? '/' : ''}${saved?.snapshotted
          ? ` — ${saved.snapshotted} file${saved.snapshotted === 1 ? '' : 's'} saved, /undo brings ${saved.unrestorable ? 'them' : 'it'} back${saved.unrestorable ? `; ${saved.unrestorable} could not be saved` : ''}`
          : tooBig ? ` — more than ${FOLDER_UNDO_MAX_FILES} files, deleted without saving them for /undo` : ''}`,
        data: { path: rel, deleted: true, existedBefore: true, existsAfter: false, verified: true, type: found.type, ...(saved ? { saved: saved.snapshotted, notSaved: saved.unrestorable } : {}) },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

