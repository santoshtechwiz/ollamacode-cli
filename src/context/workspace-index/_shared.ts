import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_INDEX_FILES = 20_000;
export const MAX_WALK_DEPTH = 10;
const MAX_HASH_BYTES = 1 * 1024 * 1024;
export const MAX_SCAN_BYTES = 256 * 1024;
export const MAX_SYMBOLS_PER_FILE = 60;
export const MAX_IMPORTS_PER_FILE = 30;
export const MAX_EDGE_RESOLUTIONS = 500;
export const MAX_SCOPE_PROJECTS = 8;

/** Bumped whenever the schema or what the index means changes. */
export const SCHEMA_VERSION = 1;

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';

export function norm(p: string) {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p;
}

export function isInside(parent: string, child: string) {
  const p = norm(parent);
  const c = norm(child);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

export function relSlash(root: string, abs: string) {
  return path.relative(root, abs).split(path.sep).join('/') || '.';
}

export function forward(p: string): string {
  return p.split(path.sep).join('/');
}

export async function statSafe(abs: string) {
  try {
    const st = await fsp.stat(abs);
    return st;
  } catch {
    return null;
  }
}

export async function hashFile(abs: string, st: import('node:fs').Stats) {
  if (st.size <= 0 || st.size > MAX_HASH_BYTES) return null;
  try {
    const fh = await fsp.open(abs, 'r');
    try {
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return crypto.createHash('sha256').update(buf.subarray(0, bytesRead)).digest('hex');
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

export const SCHEMA = `
-- Retired: a 'sessions' row was inserted per process launch and a
-- 'task_scopes' row per turn, neither was ever read, neither was swept with
-- the rest of the index, and neither was pruned. Dropped rather than left
-- behind so an existing db stops carrying the rows (and the copies of the
-- user's request text) it accumulated. task_scopes first: it referenced
-- sessions.
DROP TABLE IF EXISTS task_scopes;
DROP TABLE IF EXISTS sessions;

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY,
  root TEXT NOT NULL UNIQUE,
  opened_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  root TEXT NOT NULL,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES projects(id),
  marker TEXT,
  package_manager TEXT,
  search_text TEXT NOT NULL DEFAULT '',
  stacks_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  rel_path TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER NOT NULL DEFAULT 0,
  hash TEXT,
  imports_json TEXT NOT NULL DEFAULT '[]',
  exports_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  file_id INTEGER REFERENCES files(id),
  kind TEXT NOT NULL,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS dependencies (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'package',
  version TEXT,
  target_project_id INTEGER REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  verb TEXT NOT NULL,
  argv_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_project ON files(project_id);
CREATE INDEX IF NOT EXISTS idx_files_rel ON files(rel_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(project_id, name);
CREATE INDEX IF NOT EXISTS idx_deps_project ON dependencies(project_id, name);
CREATE INDEX IF NOT EXISTS idx_deps_target ON dependencies(target_project_id);
`;

export interface FileRow {
  rel: string;
  size: number;
  mtime: number;
  hash: string | null;
  imports: string[];
  exports: string[];
  symbols: Array<{ kind: string; name: string; }>;
}

export interface IndexHandle {
  db: import('better-sqlite3').Database;
  root: string;
  projects: Array<{ id: number; root: string; name: string; marker: string | null; stacks: import('../../types.ts').StackInfo[]; }>;
  gitTracked: boolean;
  pending: Set<Promise<unknown>>;
  onChange: (op: string, rel: string, type: 'file' | 'dir') => void;
  refreshProjectByRoot: (projectRoot: string) => void;
  /** Identity of the indexed content. */
  stamp: () => string;
  close: () => Promise<void>;
}
