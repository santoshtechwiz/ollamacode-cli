import fsp from 'node:fs/promises';
import path from 'node:path';

import { TOOL_ERROR_CODE } from '../../protocol';
import { isInside } from '../../tool/core/paths';
import { ToolError } from '../../tool/core/tool-error';
import { relTo } from '../../tool/filesystem/_fs';

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

function forCompare(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

async function realpathOrSelf(p: string): Promise<string> {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

async function realpathOfNearestExisting(target: string): Promise<string> {
  const missing: any[] = [];
  let probe = target;

  for (;;) {
    const real = await realpathOrSelf(probe);
    if (real !== probe) {
      return missing.length ? path.resolve(real, ...missing.reverse()) : real;
    }
    let present = false;
    try {
      await fsp.lstat(probe);
      present = true;
    } catch {
      present = false;
    }
    if (present) {
      return missing.length ? path.resolve(real, ...missing.reverse()) : real;
    }
    const parent = path.dirname(probe);
    if (parent === probe) return path.resolve(probe, ...missing.reverse());
    missing.push(path.basename(probe));
    probe = parent;
  }
}

export interface Workspace {
  root: string;
  resolve: (p?: string) => Promise<string>;
  resolveLexical: (p?: string) => string;
  rel: (abs: string) => string;
  contains: (abs: string) => boolean;
  grant: (dir: string) => void;
  grants: () => string[];
}

export function workspaceFor(ctx?: { ws?: Workspace; root?: string; cwd?: string; state?: { grantedRoots?: string[]; }; }): Workspace {
  if (ctx?.ws) return ctx.ws;
  const root = ctx?.root ?? ctx?.cwd ?? process.cwd();
  return createWorkspace({ root, granted: ctx?.state?.grantedRoots ?? [] });
}

export function createWorkspace({ root, granted = [] }: { root: string; granted?: string[]; }): Workspace {
  const base = path.resolve(root);
  const grantedRoots = granted.map((g: string) => path.resolve(g));

  const allowed = () => [base, ...grantedRoots];

  const contains = (abs: string) => allowed().some((dir) => isInside(dir, path.resolve(abs)));

  function resolveLexical(p: string = '.'): string {
    const value = String(p ?? '.');
    if (value.includes('\0')) {
      throw new ToolError('Path contains a NUL byte', { code: TOOL_ERROR_CODE.EINVAL });
    }
    const abs = path.resolve(base, value);
    if (!contains(abs)) {
      throw new ToolError(`Path escapes the workspace: ${p}`, {
        code: TOOL_ERROR_CODE.ESCAPE,
        hint: `Use a path inside ${base}, or start with --scope <dir> to work somewhere else.`,
      });
    }
    return abs;
  }

  async function resolve(p: string = '.'): Promise<string> {
    const abs = resolveLexical(p);

    const realAllowed = await Promise.all(allowed().map((dir) => realpathOfNearestExisting(dir)));
    const realTarget = await realpathOfNearestExisting(abs);

    if (!realAllowed.some((dir) => isInside(dir, realTarget))) {
      throw new ToolError(`Path escapes the workspace via a symlink: ${p}`, {
        code: TOOL_ERROR_CODE.ESCAPE,
        hint: 'Symlinks pointing outside the workspace are not followed.',
      });
    }
    return abs;
  }

  // A path the user let in from outside reads better whole than as a climb of ../ from the workspace.
  const rel = (abs: string): string => (isInside(base, path.resolve(abs)) ? relTo(base, abs) : path.resolve(abs));

  function grant(dir: string) {
    const abs = path.resolve(dir);
    if (!grantedRoots.some((g) => forCompare(g) === forCompare(abs))) grantedRoots.push(abs);
  }

  return {
    root: base,
    resolve,
    resolveLexical,
    rel,
    contains,
    grant,
    grants: () => [...grantedRoots],
  };
}

