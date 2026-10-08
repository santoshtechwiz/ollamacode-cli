import { TOOL_ERROR_CODE } from '../../protocol';
import fsp from 'node:fs/promises';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { statType, noteChange, findFileAncestor } from './_fs';

export default defineTool({
  name: 'create_directory',
  aliases: ['mkdir', 'make_directory', 'makedirs', 'new_folder', 'create_folder'],
  argAliases: {
    dir: 'path',
    directory: 'path',
    folder: 'path',
    name: 'path',
  },
  profiles: ['core'],
  category: 'filesystem',
  activity: 'Creating a directory',
  label: 'Create Directory',
  brief: 'Create a folder, including missing parents. Use this for folders, never write_file.',
  description:
    'Create a directory, including any missing parent directories. Use this to make a folder — never write_file.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', pathArg: true, description: 'Workspace-relative directory path' },
    },
    required: ['path'],
  },
  preview(args) {
    return `create directory ${args?.path}`;
  },
  async execute(args, ctx) {
    try {
      const abs = String(args.path);
      const rel = ctx.ws.rel(abs);

      const before = await statType(abs);
      if (before?.type === 'file') {
        return fail(`${rel} already exists and is a file, not a directory`, {
          code: TOOL_ERROR_CODE.EEXIST_FILE,
          hint: 'Choose another name, or delete the file first.',
        });
      }
      if (before?.type === 'dir') {
        return ok({
          kind: 'file',
          display: `Directory ${rel} already exists`,
          data: { path: rel, created: false, existedBefore: true, existsAfter: true, verified: true, type: 'dir' },
        });
      }

      const blocker = await findFileAncestor(ctx.root ?? ctx.cwd, abs);
      if (blocker) {
        const blockerRel = ctx.ws.rel(blocker);
        return fail(`Cannot create ${rel}: ${blockerRel} is a file, not a directory`, {
          code: TOOL_ERROR_CODE.ENOTDIR,
          hint: `Remove or rename ${blockerRel} first.`,
        });
      }

      await fsp.mkdir(abs, { recursive: true });

      const after = await statType(abs);
      if (after?.type !== 'dir') {
        return fail(`Tried to create ${rel} but it is ${after ? `a ${after.type}` : 'missing'}`, {
          code: TOOL_ERROR_CODE.EUNKNOWN,
        });
      }

      noteChange(ctx, 'mkdir', abs, 'dir');
      return ok({
        kind: 'file',
        display: `Created directory ${rel} [verified: dir]`,
        data: { path: rel, created: true, existedBefore: false, existsAfter: true, verified: true, type: 'dir' },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});

