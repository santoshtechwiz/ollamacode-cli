import fsp from 'node:fs/promises';

import { TOOL_ERROR_CODE, TOOL_RESULT_STATUS } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { statType, noteChange } from './_fs';

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
    'A file with content must be read in this turn first. Check nothing still references it, and afterwards verify the project still builds.',
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
        display: `Deleted ${rel}${found.type === 'dir' ? '/' : ''}`,
        data: { path: rel, deleted: true, existedBefore: true, existsAfter: false, verified: true, type: found.type },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

