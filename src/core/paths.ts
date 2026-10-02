import { statSync } from 'node:fs';
import path from 'node:path';

import { STORAGE } from '../protocol';

/** Where a session's checkpoint lives. */
function checkpointsDir(workspaceRoot: string): string {
  return path.join(path.resolve(workspaceRoot), STORAGE.PROJECT_DIR, STORAGE.CHECKPOINTS_DIR);
}

export function checkpointPath(workspaceRoot: string, sessionId: string): string {
  return path.join(checkpointsDir(workspaceRoot), `${sessionId}.json`);
}

/** A file's identity on disk right now, as `size:mtimeMs`, or null if it cannot be read. */
export function fileStamp(absPath: string): string | null {
  if (!absPath) return null;
  try {
    const st = statSync(absPath);
    return `${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
}

export function normalizeRelPath(p: string): string {
  return String(p ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

export function samePath(a: unknown, b: unknown): boolean {
  const x = normalizeRelPath(a as string);
  const y = normalizeRelPath(b as string);
  return Boolean(x) && Boolean(y) && (x === y || x.endsWith('/' + y) || y.endsWith('/' + x));
}

