import path from 'node:path';

import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail } from '../core/tool-result';
import { noteChange } from './_fs';
import { undoLast, sessionHasLedger } from '../../core/session-recovery';

export default defineTool({
  name: 'undo',
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Undoing a change',
  label: 'Undo',
  brief: 'Restore the bytes a file had before this session changed it, or remove a file this session created.',
  risky: true,
  description:
    'Revert a change made earlier in this session. write_file, edit_file, move_file and delete_file copy the file\'s previous bytes before they run, and this call puts those bytes back — or removes a file that write_file created. ' +
    'A shell delete is snapshotted too: every file Remove-Item, del or rm removes in this session is copied into the session recovery store first, so this call brings a deleted file — or a whole deleted folder, when called with no path — back. ' +
    'Give `path` to undo the most recent recorded change to that file; omit it to undo the overall most recent recorded change. ' +
    'Only the session\'s own recorded mutations can be undone; a multi-file patch from a tool that does not snapshot, or a delete whose targets could not be copied, has no pre-image and nothing happens.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        pathArg: true,
        description: 'Optional workspace-relative path; undo only the most recent recorded change to this file',
      },
    },
    required: [],
  },

  preview(args) {
    return `undo ${args?.path ?? 'most recent file change'}`;
  },

  async execute(args, ctx) {
    const sessionId = ctx?.state?.sessionId;
    if (!sessionHasLedger(sessionId)) {
      return fail('No recovery ledger for this session', {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'File pre-images are recorded per conversation; this session does not have one.',
      });
    }

    const rel = args?.path ? ctx.ws.rel(String(args.path)) : undefined;
    try {
      const outcome = await undoLast(ctx.ws.root, sessionId, rel);
      if (!outcome) {
        return ok({
          kind: 'status',
          display: rel
            ? `No recorded change to undo for ${rel}`
            : 'No recorded change to undo',
          data: { undone: false, path: rel ?? null },
        });
      }
      const { entry, action, paths } = outcome;
      const abs = path.resolve(ctx.ws.root, entry.rel);
      noteChange(ctx, action === 'restored' ? 'restore' : 'delete', abs, 'file');
      const many = (paths?.length ?? 0) > 1;
      return ok({
        kind: 'status',
        display: many
          ? `Put back ${paths!.length} files deleted by ${entry.tool} (${entry.rel} and ${paths!.length - 1} more)`
          : action === 'restored'
            ? `Restored ${entry.rel} to its previous bytes (before ${entry.tool})`
            : `Removed ${entry.rel} (created by ${entry.tool})`,
        data: { undone: true, path: entry.rel, action, tool: entry.tool, paths: paths ?? [entry.rel] },
      });
    } catch (err) {
      return fail(`Could not undo: ${(err as Error)?.message ?? String(err)}`);
    }
  },
});