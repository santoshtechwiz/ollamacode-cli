
import fsp from 'node:fs/promises';
import path from 'node:path';
import { STORAGE } from '../../protocol';

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'obj',
  '__pycache__',
  '.next',
  '.nuxt',
  '.output',
  '.venv',
  'venv',
  'coverage',
  '.ollamacode',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.gradle',
  '.idea',
  '.vscode',
  'vendor',
  'target',
]);

// ocode's own folders hold its records of this session (checkpoints, recovery copies, the index); a search that
// walked into them would find the task's own words and report them as the project's.
const ALWAYS_SKIP_DIRS = new Set(['.git', 'node_modules', STORAGE.PROJECT_DIR]);

export const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.wasm', '.class', '.jar',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.mkv', '.webm', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pyc', '.pyo', '.o', '.a', '.lib', '.pdb', '.node',
  '.sqlite', '.db',
]);

export interface StatInfo {
  type: 'file' | 'dir' | 'symlink';
  size: number;
  mode: number;
}

export function relTo(base: string, abs: string): string {
  const rel = path.relative(base, path.resolve(abs)).split(path.sep).join('/') || '.';
  const norm = rel.replace(/\/+$/, '');
  // Real case, as on disk: the model and the person both read these; comparisons fold case themselves.
  return norm === '' ? '.' : norm;
}

/** Record a filesystem mutation on the session journal and drop any memo of it. */
export function noteChange(
  ctx: import('../../types.ts').ToolContextInput,
  op: string,
  abs: string,
  type: 'file' | 'dir'
) {
  const rel = ctx?.ws?.rel ? ctx.ws.rel(abs) : relTo(ctx?.root ?? '.', abs);
  ctx?.state?.note?.(op, rel, type);
  ctx?.memo?.invalidatePath?.(abs);
}

export function isSkippedDir(name: string): boolean {
  return SKIP_DIRS.has(name);
}

export function isBinaryExtension(file: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(file).toLowerCase());
}

export function decodeUtf8(buf: Buffer): { text: string; lossless: boolean; } {
  const text = buf.toString('utf8');
  return { text, lossless: Buffer.from(text, 'utf8').equals(buf) };
}

export async function isBinaryFile(file: string): Promise<boolean> {
  if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) return true;
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(1024);
    const { bytesRead } = await handle.read(buf, 0, 1024, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    await handle?.close().catch(() => {});
  }
}

interface WalkOptions {
  maxDepth?: number;
  maxEntries?: number;
  signal?: AbortSignal;
  /** Descend into hidden and build directories, stopping only at .git/node_modules. */
  allFiles?: boolean;
}

interface WalkedFile {
  abs: string;
  rel: string;
}

export async function* walkFiles(
  root: string,
  { maxDepth = 12, maxEntries = 200_000, signal, allFiles = false }: WalkOptions = {}
): AsyncGenerator<WalkedFile, void, unknown> {
  const base = path.resolve(root);
  let seen = 0;

  async function* walk(dir: string, depth: number): AsyncGenerator<WalkedFile, void, unknown> {
    if (depth > maxDepth || seen >= maxEntries) return;
    if (signal?.aborted) return;

    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: skip, do not abort the walk
    }

    for (const entry of entries) {
      if (seen >= maxEntries || signal?.aborted) return;
      const abs = path.join(dir, entry.name);

      if (entry.isSymbolicLink()) continue; // never follow: cycles and escapes
      if (entry.isDirectory()) {
        if (allFiles) {
          if (ALWAYS_SKIP_DIRS.has(entry.name)) continue;
        } else {
          if (isSkippedDir(entry.name) || entry.name.startsWith('.')) continue;
        }
        yield* walk(abs, depth + 1);
      } else if (entry.isFile()) {
        seen += 1;
        yield { abs, rel: relTo(base, abs) };
      }
    }
  }

  yield* walk(base, 0);
}

export async function writeFileAtomic(
  file: string,
  content: string,
  prevStat: StatInfo | null = null,
  expectedBytes?: Buffer | null,
) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  let mode: number | null = null;
  try {
    const st = await fsp.stat(file);
    mode = st.mode;
  } catch {}
  const uniq = `${Date.now().toString(36)}-${Math.random().toString(16).slice(2)}`;
  const tmp = `${file}.tc-${process.pid}-${uniq}.tmp`;
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    if (mode !== null) {
      await fsp.chmod(tmp, mode).catch(() => {});
    } else if (prevStat && typeof prevStat.mode === 'number') {
      await fsp.chmod(tmp, prevStat.mode).catch(() => {});
    }
    if (expectedBytes !== undefined) {
      let current: Buffer | null = null;
      try {
        current = await fsp.readFile(file);
      } catch {}
      const matches = expectedBytes === null
        ? current === null
        : current !== null && current.equals(expectedBytes);
      if (!matches) {
        const error = new Error('file changed on disk before the atomic write');
        (error as Error & { code?: string }).code = 'EBUSY';
        throw error;
      }
    }
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export async function statType(abs: string): Promise<StatInfo | null> {
  try {
    const s = await fsp.lstat(abs);
    if (s.isSymbolicLink()) return { type: 'symlink', size: s.size, mode: s.mode };
    return { type: s.isDirectory() ? 'dir' : 'file', size: s.size, mode: s.mode };
  } catch {
    return null;
  }
}

export async function findFileAncestor(root: string, abs: string): Promise<string | null> {
  const stop = path.resolve(root);
  const ancestors: string[] = [];
  let probe = path.dirname(path.resolve(abs));

  while (probe.length >= stop.length && probe !== path.dirname(probe)) {
    ancestors.push(probe);
    if (probe === stop) break;
    probe = path.dirname(probe);
  }

  for (const dir of ancestors.reverse()) {
    const found = await statType(dir);
    if (found && found.type !== 'dir') return dir;
  }
  return null;
}
