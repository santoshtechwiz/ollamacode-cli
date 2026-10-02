import spawn from 'cross-spawn';
import { childEnv, resolveShell } from '../shell/runtime';
import { processManager } from '../../../env/process/index';
import { createOutput, pushOutput } from './output-buffer';

import type { SubprocessRecord } from '../subprocess-state';

export interface SpawnRequest {
  id: string;
  command: string;
  cwd: string;
  ownerId?: string;
}

/**
 * Spawn a background shell child. cross-spawn owns Windows quoting/PATHEXT,
 * so no windowsVerbatimArguments juggling. Wires capped output capture and
 * lifecycle flags; the caller owns session registration and the spawn handshake.
 */
export function createSubprocess({ id, command, cwd, ownerId }: SpawnRequest): SubprocessRecord {
  const { file, args: shellArgs } = resolveShell();

  const child = spawn(file, shellArgs(command), {
    cwd,
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    ...(process.platform !== 'win32' ? { detached: true } : {}),
  });

  const sub: SubprocessRecord = {
    id,
    command,
    cwd,
    process: child,
    startedAt: Date.now(),
    stdout: createOutput(),
    stderr: createOutput(),
    exited: false,
    exitCode: null,
    signal: null,
    discardedBytes: 0,
    state: 'starting',
    pid: child.pid,
    ownerId,
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    pushOutput(sub.stdout, chunk);
    sub.discardedBytes = sub.stdout.discardedBytes + sub.stderr.discardedBytes;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    pushOutput(sub.stderr, chunk);
    sub.discardedBytes = sub.stdout.discardedBytes + sub.stderr.discardedBytes;
  });
  child.on('error', (err) => {
    sub.exited = true;
    sub.state = 'failed';
    sub.error = err.message;
  });
  child.on('close', (code, signal) => {
    sub.exited = true;
    sub.state = 'exited';
    sub.exitCode = code;
    sub.signal = signal;
    processManager.untrackExternal(child);
  });
  child.on('exit', (code, signal) => {
    sub.exitCode = code;
    sub.signal = signal;
    if (sub.state !== 'failed') {
      sub.state = 'exited';
      sub.exited = true;
    }
  });

  processManager.trackExternal(child);
  return sub;
}

/** Resolve once the child reports `spawn`, or with the spawn error. */
export function awaitSpawn(sub: SubprocessRecord): Promise<Error | null> {
  const child = sub.process;
  return new Promise((resolve) => {
    child.once('spawn', () => {
      sub.state = 'running';
      resolve(null);
    });
    child.once('error', (err) => resolve(err));
  });
}

/** Quiet for this long after printing something: a server has usually finished starting up. */
const SETTLE_MS = 2_000;
/**
 * Silent for this long since it started: the job is running on its own and is handed to the background, instead of
 * holding the turn until it ends (a fetch, a silent build). Longer than SETTLE_MS because it also covers starting
 * the shell and the program (PowerShell alone can take a couple of seconds), so a quick job still finishes here
 * and returns its result.
 */
const SILENT_START_MS = 5_000;
/** Never hold the turn longer than this; the process keeps running either way. */
const MAX_WAIT_MS = 20_000;
const POLL_MS = 200;

export type StartOutcome = 'exited' | 'settled' | 'still-starting' | 'cancelled';

/** Wait until the process exits, goes quiet, times out, or the turn is cancelled. */
export async function awaitStartup(sub: SubprocessRecord, signal?: AbortSignal): Promise<StartOutcome> {
  const started = Date.now();
  let lastBytes = -1;
  let quietSince = Date.now();
  for (;;) {
    if (sub.exited) return 'exited';
    if (signal?.aborted) return 'cancelled';
    const bytes = sub.stdout.bytes + sub.stderr.bytes;
    if (bytes !== lastBytes) {
      lastBytes = bytes;
      quietSince = Date.now();
    } else if (Date.now() - quietSince >= (bytes > 0 ? SETTLE_MS : SILENT_START_MS)) {
      return 'settled';
    }
    if (Date.now() - started >= MAX_WAIT_MS) return 'still-starting';
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
