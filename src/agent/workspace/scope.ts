import path from 'node:path';

function isPosixAbsolute(p: string): boolean {
  return p.startsWith('/');
}

function posixResolve(cwd: string, ...paths: string[]): string {
  let resolved = cwd;
  for (const p of paths) {
    if (isPosixAbsolute(p)) {
      resolved = p;
    } else {
      resolved = resolved.replace(/\/+$/, '') + '/' + p;
    }
  }
  // Normalize: remove . and .. segments
  const parts = resolved.split('/').filter(p => p !== '');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      if (stack.length > 0) stack.pop();
    } else if (part !== '.') {
      stack.push(part);
    }
  }
  return '/' + stack.join('/');
}

export function resolveScope(cwd: string, scope?: string): string {
  const isPosix = isPosixAbsolute(cwd);
  if (!scope) return isPosix ? posixResolve(cwd) : path.resolve(cwd);
  const trimmed = String(scope).trim();
  if (!trimmed || trimmed === '.' || trimmed === './') return isPosix ? posixResolve(cwd) : path.resolve(cwd);
  if (isPosix) {
    return isPosixAbsolute(trimmed)
      ? posixResolve(trimmed)
      : posixResolve(cwd, trimmed);
  }
  return path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(cwd, trimmed);
}
