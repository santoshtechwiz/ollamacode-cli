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
