import { spawn } from 'node:child_process';
import { logger } from '../../core/logger';
import { killProcessTree } from './kill';
import type { ChildOutcome, RunOptions } from './types';

const DRAIN_GRACE_MS = 1_500;
const KILL_GRACE_MS = 1_500;
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const ABSOLUTE_MAX_MS = 30 * 60_000;

export function runChild({
  file,
  args,
  options = {},
  timeoutMs,
  signal,
  maxCaptureBytes = MAX_CAPTURE_BYTES,
  onOutput,
  release,
}: RunOptions): Promise<ChildOutcome> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let discardedBytes = 0;

    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let timer: NodeJS.Timeout | null = null;
    let absoluteTimer: NodeJS.Timeout | null = null;
    let grace: NodeJS.Timeout | null = null;
    let releaseTimer: NodeJS.Timeout | null = null;
    let seen = '';

    const outcome = {
      exitCode: null,
      signal: null,
      spawnError: null,
      stdout: '',
      stderr: '',
      discardedBytes: 0,
      timedOut: false,
      cancelled: false,
      pid: child.pid,
    } as ChildOutcome;

    const collect = (chunks: Buffer[], bytes: number, chunk: Buffer) => {
      if (bytes >= maxCaptureBytes) {
        discardedBytes += chunk.length;
        return bytes;
      }
      chunks.push(chunk);
      return bytes + chunk.length;
    };

    const settleAfterKill = () => {
      if (settled || grace) return;
      const onExit = () => finish();
      child.once('exit', onExit);
      grace = setTimeout(() => {
        child.removeListener('exit', onExit);
        finish();
      }, KILL_GRACE_MS);
      grace.unref?.();
    };

    const finish = (patch: Partial<ChildOutcome> = {}) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (absoluteTimer) clearTimeout(absoluteTimer);
      if (grace) clearTimeout(grace);
      if (releaseTimer) clearTimeout(releaseTimer);
      signal?.removeEventListener('abort', onAbort);
      Object.assign(outcome, patch, {
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        discardedBytes,
        timedOut,
        cancelled,
      });
      try {
        if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
      } catch {}
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve(outcome);
    };

    const onAbort = () => {
      cancelled = true;
      killProcessTree(child);
      settleAfterKill();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const scheduleGrace = (ms: number) => {
      if (settled || grace) return;
      grace = setTimeout(() => finish(), ms);
      grace.unref?.();
    };

    const onTimedOut = () => {
      timedOut = true;
      killProcessTree(child);
      settleAfterKill();
    };
    const armIdleTimer = () => {
      if (!timeoutMs || settled || grace) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(onTimedOut, timeoutMs);
      timer.unref?.();
    };
    armIdleTimer();
    if (timeoutMs) {
      absoluteTimer = setTimeout(onTimedOut, Math.min(timeoutMs, ABSOLUTE_MAX_MS));
      absoluteTimer.unref?.();
    }

    const emitOutput = (chunk: Buffer) => {
      if (!onOutput || !chunk.length) return;
      try {
        onOutput(chunk.toString('utf8'));
      } catch (err) {
        logger.debug('onOutput callback threw:', err);
      }
    };

    /**
     * The process is handed back still running, with what it printed so far: it showed it is serving (release.when) and
     * then went quiet. Its listeners here come off and its streams pause, so the next owner reads on from where this
     * one stopped; nothing is killed.
     */
    const releaseChild = () => {
      if (settled || child.exitCode !== null || child.signalCode !== null) return;
      settled = true;
      for (const t of [timer, absoluteTimer, grace]) if (t) clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      child.stdout?.removeListener('data', onStdout);
      child.stderr?.removeListener('data', onStderr);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      child.stdout?.pause();
      child.stderr?.pause();
      Object.assign(outcome, {
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        discardedBytes,
        released: child,
      });
      resolve(outcome);
    };
    const watchRelease = (chunk: Buffer) => {
      if (!release || settled) return;
      seen = (seen + chunk.toString('utf8')).slice(-65_536);
      if (releaseTimer) clearTimeout(releaseTimer);
      if (!release.when(seen)) return;
      releaseTimer = setTimeout(releaseChild, release.quietMs);
      releaseTimer.unref?.();
    };

    const onStdout = (c: Buffer) => {
      stdoutBytes = collect(stdoutChunks, stdoutBytes, c);
      armIdleTimer();
      emitOutput(c);
      watchRelease(c);
    };
    const onStderr = (c: Buffer) => {
      stderrBytes = collect(stderrChunks, stderrBytes, c);
      armIdleTimer();
      emitOutput(c);
      watchRelease(c);
    };
    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
      if (releaseTimer) clearTimeout(releaseTimer);
      outcome.exitCode = signedExit(code);
      outcome.signal = sig;
      scheduleGrace(DRAIN_GRACE_MS);
    };
    const onClose = (code: number | null, sig: NodeJS.Signals | null) => {
      finish({ exitCode: signedExit(code), signal: sig });
    };
    const onError = (err: Error) => {
      if (outcome.exitCode !== null || outcome.signal !== null || settled) {
        logger.debug('child error after exit ignored:', err.message);
        return;
      }
      finish({ spawnError: err });
    };
    child.on('exit', onExit);
    child.on('close', onClose);
    child.on('error', onError);
  });
}

/**
 * Windows hands back an exit code as an unsigned 32-bit number, so npm's -4058 (file not found) arrives as 4294963238.
 * Read as signed, it is the number the program meant and the one its docs and error messages use.
 */
function signedExit(code: number | null): number | null {
  return code !== null && code > 0x7fffffff ? code - 0x100000000 : code;
}
