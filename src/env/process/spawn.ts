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

    child.stdout?.on('data', (c: Buffer) => {
      stdoutBytes = collect(stdoutChunks, stdoutBytes, c);
      armIdleTimer();
      emitOutput(c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderrBytes = collect(stderrChunks, stderrBytes, c);
      armIdleTimer();
      emitOutput(c);
    });
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    child.on('exit', (code, sig) => {
      outcome.exitCode = code;
      outcome.signal = sig;
      scheduleGrace(DRAIN_GRACE_MS);
    });

    child.on('close', (code, sig) => {
      finish({ exitCode: code, signal: sig });
    });

    child.on('error', (err) => {
      if (outcome.exitCode !== null || outcome.signal !== null || settled) {
        logger.debug('child error after exit ignored:', err.message);
        return;
      }
      finish({ spawnError: err });
    });
  });
}
