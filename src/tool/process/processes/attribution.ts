import path from 'node:path';

export interface ProcessInfo {
  pid: number;
  image: string;
  command: string;
  exePath?: string;
  /** The process that started it, when the OS says. */
  parentPid?: number;
}

export function isProtectedPid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  if (pid === 1 || pid === 4 || pid === process.pid) return true;
  return false;
}

function normalizePath(p: string): string {
  return String(p ?? '').replace(/\\/g, '/').toLowerCase();
}

function isUnderRoot(candidate: string | undefined, root: string): boolean {
  if (!candidate || !root) return false;
  const normRoot = normalizePath(root).replace(/\/+$/, '');
  const norm = normalizePath(candidate);
  return norm === normRoot || norm.startsWith(`${normRoot}/`);
}

export interface Attribution {
  proc: ProcessInfo;
  /** Why this process may be stopped without asking. Null means ask first. */
  safeReason: string | null;
}

/** Attribute candidate lock holders to this task/project. */
export function attributeProcesses(
  candidates: ProcessInfo[],
  opts: { root: string; ownPids?: Set<number> | number[]; rootHints?: string[] },
): Attribution[] {
  const own = new Set(Array.isArray(opts.ownPids) ? opts.ownPids : (opts.ownPids ?? []));
  const hints = (opts.rootHints ?? []).map(normalizePath).filter(Boolean);
  return candidates.map((proc) => {
    if (isProtectedPid(proc.pid)) return { proc, safeReason: null };
    if (own.has(proc.pid)) return { proc, safeReason: 'started by this session' };
    if (proc.exePath && isUnderRoot(proc.exePath, opts.root)) {
      return { proc, safeReason: 'executable under the workspace root' };
    }
    const hay = normalizePath(`${proc.command ?? ''} ${proc.exePath ?? ''}`);
    const normRoot = normalizePath(opts.root).replace(/\/+$/, '');
    if (hay.includes(normRoot)) return { proc, safeReason: 'command line references the workspace' };
    for (const hint of hints) {
      if (hint && hay.includes(hint)) return { proc, safeReason: 'command line references the project output' };
    }
    return { proc, safeReason: null };
  });
}

/** Lock-holder candidates: image or command line names one of the locked files. */
export function candidatesForLock(processes: ProcessInfo[], lockedFiles: string[]): ProcessInfo[] {
  const basenames = new Set(
    lockedFiles
      .map((f) => path.win32.basename(String(f)).toLowerCase())
      .concat(lockedFiles.map((f) => path.posix.basename(String(f)).toLowerCase()))
      .filter(Boolean),
  );
  if (basenames.size === 0) return [];
  return processes.filter((p) => {
    if (basenames.has(String(p.image ?? '').toLowerCase())) return true;
    // A hosted runtime holds the lock under its own image name; the locked file only appears on its command line.
    const command = String(p.command ?? '').toLowerCase();
    for (const name of basenames) {
      if (command.includes(name)) return true;
    }
    return false;
  });
}
