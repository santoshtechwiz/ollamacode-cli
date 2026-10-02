import fs from 'node:fs';
import path from 'node:path';

const BUILD_OUTPUT =
  /(^|[\\/])(obj|node_modules|\.pnpm|\.yarn|\.venv|venv|site-packages|dist-packages|\.tox|\.eggs|\.pytest_cache|\.mypy_cache|\.ruff_cache|__pycache__|dist|build|out|target|vendor|\.gradle|\.next|\.nuxt|coverage|\.terraform)[\\/]/i;

const DOTNET_BIN = /(^|[\\/])bin[\\/](Debug|Release)[\\/]/i;

const GENERATED_NAME = /\.(g|generated|designer)\.[A-Za-z0-9]+$|\.min\.(js|css)$|_pb2(_grpc)?\.py$/i;

const canonicals = new Map<string, string>();
const CANONICAL_CACHE_MAX = 500;

/** A path as the filesystem itself spells it. */
function canonical(p: string): string {
  const cached = canonicals.get(p);
  if (cached !== undefined) return cached;

  // Canonicalize the nearest existing ancestor and re-append the rest, so deleted or not-yet-built files still resolve.
  const abs = path.resolve(p);
  const tail: string[] = [];
  let base = abs;
  for (;;) {
    try {
      base = fs.realpathSync.native(base);
      break;
    } catch {
      const parent = path.dirname(base);
      if (parent === base) {
        base = abs;
        tail.length = 0;
        break;
      }
      tail.unshift(path.basename(base));
      base = parent;
    }
  }

  const resolved = tail.length > 0 ? path.join(base, ...tail) : base;
  if (canonicals.size >= CANONICAL_CACHE_MAX) canonicals.clear();
  canonicals.set(p, resolved);
  return resolved;
}

/** `file` relative to `base`, or null when it is not underneath it. */
function under(base: string, file: string): string | null {
  const rel = path.relative(base, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

function containedIn(file: string, root: string): string | null {
  // Lexical first: it needs no syscall and settles almost every case.
  return (
    under(path.resolve(root), path.resolve(file)) ??
    under(canonical(root), canonical(file))
  );
}

function outsideWorkspace(file: string, root?: string): boolean {
  if (!root || !path.isAbsolute(file)) return false;
  return containedIn(file, root) === null;
}

/** Rewrite every workspace path inside a block of tool output as a relative one. */
export function shortenPaths(text: string, root?: string): string {
  const out = String(text ?? '');
  if (!root || !out) return out;

  // Never strip a filesystem root as a prefix; it would turn unrelated absolute paths into misleading relative ones.
  const probe = path.resolve(root);
  if (path.dirname(probe) === probe) return out;

  const bases = new Set<string>();
  for (const base of [path.resolve(root), canonical(root)]) {
    if (!base) continue;
    bases.add(base);
    bases.add(base.replace(/\\/g, '/'));
  }

  let result = out;
  // Longest first, so a nested root never leaves half a prefix behind.
  for (const base of [...bases].sort((a, b) => b.length - a.length)) {
    for (const sep of ['\\', '/']) {
      result = result.split(base + sep).join('');
    }
  }
  return result;
}

export function isEditableSource(file: string | undefined, root?: string): boolean {
  const target = String(file ?? '').trim();
  if (!target) return false;
  if (target.startsWith('(') || target.startsWith('<') || target.startsWith('node:')) return false;
  if (outsideWorkspace(target, root)) return false;
  return !BUILD_OUTPUT.test(target) && !DOTNET_BIN.test(target) && !GENERATED_NAME.test(target);
}
