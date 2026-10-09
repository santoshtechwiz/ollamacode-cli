import { execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { logger } from '../../core/logger';

const require = createRequire(import.meta.url);
// NOTE: @ekaone/killx@0.1.2 ships a broken ESM entry (its exports.import points
// at dist/index.mjs, which is not published), so load the CJS bundle explicitly.
// If upstream fixes the packaging, switch this to a plain ESM import.
const { killx } = require('@ekaone/killx') as typeof import('@ekaone/killx');

const KILL_GRACE_MS = 1_500;
const KILL_TIMEOUT_MS = 3_000;

/**
 * Stop a process and everything it started. On Windows `taskkill /T` walks the tree itself: killx first lists it with
 * one synchronous `wmic` per process, which froze the whole of ocode while it ran, and hung outright where wmic is
 * missing or slow (current Windows), with no timer able to fire.
 */
function killTree(pid: number, timeoutMs: number): Promise<{ success: boolean; failed?: string }> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: timeoutMs }, (err, _out, stderr) => {
        // A process that ended before taskkill reached it is what was wanted.
        if (!err || isGone(pid)) resolve({ success: true });
        else resolve({ success: false, failed: `${pid}: ${String(stderr || err.message).trim()}` });
      });
    });
  }
  return killx(pid, { force: true, timeout: timeoutMs }).then((result) => ({
    success: result.success,
    failed: result.failed?.map((f) => `${f.pid}: ${f.error}`).join('; '),
  }));
}

/** Fire-and-forget tree kill with SIGTERM → SIGKILL escalation. */
export function killProcessTree(child: import('node:child_process').ChildProcess): void {
  const pid = child?.pid;
  if (!pid) return;
  void killTree(pid, KILL_GRACE_MS)
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

/**
 * Stop a process and everything it started while ocode itself is exiting. Nothing asynchronous runs once the 'exit'
 * event fires, so the asynchronous kill above never reached the children there, and dev servers outlived the session
 * holding their ports. Elsewhere children are started detached, each leading its own process group, so one signal
 * reaches the whole group; Windows has no groups to signal, and taskkill /T walks the tree.
 */
export function killTreeSync(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: KILL_TIMEOUT_MS });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch {
    // Not a group leader, or already gone: the process itself, if it is still there.
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
}

/** Tree-kill one PID with escalation; throws when the process survives. */
export async function killPid(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`invalid pid ${pid}`);
  const result = await killTree(pid, KILL_TIMEOUT_MS);
  logger.debug(`kill PID ${pid}: success=${result.success}`);
  if (!result.success || !isGone(pid)) {
    const failed = result.failed;
    throw new Error(failed ? `could not stop PID ${pid} (${failed})` : `PID ${pid} is still running after kill`);
  }
}
