import fsp from 'node:fs/promises';
import path from 'node:path';

import { TOOL_ERROR_CODE, TOOL_RESULT_STATUS } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { statType, noteChange, findFileAncestor } from './_fs';
import { FOLDER_UNDO_MAX_FILES, hasMoreFilesThan, snapshotPaths } from '../../core/session-recovery';

/**
 * Moving is not writing a copy and deleting the original: a model without a move wrote the copy, left the original
 * where it was, and said it had moved it.
 */
export default defineTool({
  name: 'move_file',
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Moving a file',
  label: 'Move',
  brief: 'Move or rename a file or folder. Into an existing folder, it keeps its name.',
  risky: true,
  restorable: true,
  confirmReason: () => 'moves files',
  description:
    'Move or rename a file or folder in one step; the original is gone afterwards. When to is an existing folder, the ' +
    'file goes into it under its own name. Refuses to overwrite: an existing file at the destination is left alone. ' +
    'Update anything that refers to the old path (imports, docs, configs) afterwards.',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', pathArg: true, description: 'Workspace-relative file or folder to move' },
      to: { type: 'string', pathArg: true, description: 'Its new path, or an existing folder to move it into' },
    },
    required: ['from', 'to'],
  },

  preview(args) {
    return `move ${args?.from} → ${args?.to}`;
  },

  async execute(args, ctx) {
    try {
      const from = String(args.from);
      const fromRel = ctx.ws.rel(from);
      if (from === ctx.ws.root || fromRel === '.') {
        return fail('Refusing to move the workspace root', { code: TOOL_ERROR_CODE.EINVAL, hint: 'Move the files or folders inside it.' });
      }

      const source = await statType(from);
      if (!source) {
        return fail(`${fromRel} does not exist — nothing to move`, {
          code: TOOL_ERROR_CODE.ENOENT,
          status: TOOL_RESULT_STATUS.NOT_FOUND,
          hint: 'Check the path with list_directory or find_files.',
        });
      }

      const asked = String(args.to);
      const into = await statType(asked);
      const to = into?.type === 'dir' ? path.join(asked, path.basename(from)) : asked;
      const toRel = ctx.ws.rel(to);
      if (path.resolve(to) === path.resolve(from)) {
        return fail(`${fromRel} is already at ${toRel}`, { code: TOOL_ERROR_CODE.EINVAL, hint: 'Give a different destination.' });
      }
      if (source.type === 'dir' && (path.resolve(to) + path.sep).startsWith(path.resolve(from) + path.sep)) {
        return fail(`Cannot move ${fromRel} into itself (${toRel})`, { code: TOOL_ERROR_CODE.EINVAL, hint: 'Give a destination outside the folder being moved.' });
      }
      if (await statType(to)) {
        return fail(`${toRel} already exists — nothing was moved`, {
          code: TOOL_ERROR_CODE.EEXIST_FILE,
          hint: `Pick another destination, or delete ${toRel} first if it should be replaced.`,
        });
      }
      const blocker = await findFileAncestor(ctx.root ?? ctx.cwd, to);
      if (blocker) {
        return fail(`Cannot move to ${toRel}: ${ctx.ws.rel(blocker)} is a file, not a folder`, {
          code: TOOL_ERROR_CODE.ENOTDIR,
          hint: 'Choose a destination inside a folder.',
        });
      }

      // A file's bytes are saved by the runtime before any restorable call; a folder's are saved here, as delete_file does.
      const tooBig = source.type === 'dir' && await hasMoreFilesThan(from, FOLDER_UNDO_MAX_FILES);
      if (source.type === 'dir' && !tooBig) {
        await snapshotPaths({ root: ctx.ws.root, sessionId: ctx.state?.sessionId, tool: 'move_file', targets: [from] });
      }

      await fsp.mkdir(path.dirname(to), { recursive: true });
      try {
        await fsp.rename(from, to);
      } catch (err) {
        // Another drive or volume: rename cannot cross it, so copy and then remove.
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
        await fsp.rm(from, { recursive: true, force: true });
      }

      const [left, arrived] = await Promise.all([statType(from), statType(to)]);
      if (left || !arrived) {
        return fail(`Moving ${fromRel} to ${toRel} did not complete`, {
          code: TOOL_ERROR_CODE.EPERM,
          status: TOOL_RESULT_STATUS.NOT_VERIFIED,
          hint: left ? 'Something is holding the original open, or permissions prevent removing it.' : 'The destination could not be written.',
        });
      }

      const type = source.type === 'dir' ? 'dir' : 'file';
      noteChange(ctx, 'delete', from, type);
      noteChange(ctx, 'create', to, type);
      const slash = type === 'dir' ? '/' : '';
      return ok({
        kind: 'status',
        display: `Moved ${fromRel}${slash} to ${toRel}${slash}${tooBig ? ` — more than ${FOLDER_UNDO_MAX_FILES} files, not saved for /undo` : ''}`,
        data: { from: fromRel, to: toRel, type, moved: true, verified: true },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});
