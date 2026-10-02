import { createRequire } from 'node:module';
import { logger } from '../../core/logger';

const require = createRequire(import.meta.url);
// NOTE: @ekaone/killx@0.1.2 ships a broken ESM entry (its exports.import points
// at dist/index.mjs, which is not published), so load the CJS bundle explicitly.
// If upstream fixes the packaging, switch this to a plain ESM import.
const { killx } = require('@ekaone/killx') as typeof import('@ekaone/killx');

const KILL_GRACE_MS = 1_500;
const KILL_TIMEOUT_MS = 3_000;

/** Fire-and-forget tree kill with SIGTERM → SIGKILL escalation. */
export function killProcessTree(child: import('node:child_process').ChildProcess): void {
  const pid = child?.pid;
  if (!pid) return;
  void killx(pid, { force: true, timeout: KILL_GRACE_MS })
    .then((result) => {
      if (!result.success || !isGone(pid)) {
        logger.debug(`process ${pid} still alive after kill — possible orphan`);
      }
    })
    .catch((err) => {
      logger.debug(`kill of process ${pid} failed: ${(err as Error)?.message ?? err}`);
    });
}

export function killProcessTreeAndWait(
  child: import('node:child_process').ChildProcess,
  graceMs: number = KILL_GRACE_MS
): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', done);
    const timer = setTimeout(done, graceMs);
    timer.unref?.();
    killProcessTree(child);
  });
}

export function isGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'ESRCH';
  }
}

/** Tree-kill one PID with escalation; throws when the process survives. */
export async function killPid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`);
  const result = await killx(pid, { force: true, timeout: KILL_TIMEOUT_MS });
  const killed = result.killed.length;
  logger.debug(`kill PID ${pid}: success=${result.success} killed=${killed}`);
  if (!result.success || !isGone(pid)) {
    const failed = result.failed?.map((f) => `${f.pid}: ${f.error}`).join('; ');
    throw new Error(failed ? `could not stop PID ${pid} (${failed})` : `PID ${pid} is still running after kill`);
  }
}

export async function waitForExit(pid: number, timeoutMs: number = 5000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isGone(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return isGone(pid);
}
