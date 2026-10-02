import { killProcessTree } from './kill';

/** Tracks externally-spawned children so the process-exit handler still cleans them up. */
class ProcessManager {
  private external = new Set<import('node:child_process').ChildProcess>();

  constructor() {
    process.on('exit', () => {
      for (const child of this.external) {
        try { killProcessTree(child); } catch {}
      }
    });
  }

  trackExternal(child: import('node:child_process').ChildProcess): void {
    if (child?.pid) this.external.add(child);
    child.once('close', () => this.external.delete(child));
    child.once('exit', () => this.external.delete(child));
  }

  untrackExternal(child: import('node:child_process').ChildProcess): void {
    this.external.delete(child);
  }
}

/** Global singleton — process owns the handles, session owns the ownership. */
export const processManager = new ProcessManager();
