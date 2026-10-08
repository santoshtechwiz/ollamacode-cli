import { TOOL_ERROR_CODE } from '../../protocol';
import { fail } from '../core/tool-result';
import { clearOutput, readOutput, type CappedOutput } from './lifecycle/output-buffer';

import type { ProcessState } from '../../env/process/types';

export interface SubprocessRecord {
  id: string;
  command: string;
  cwd: string;
  process: import('node:child_process').ChildProcess;
  startedAt: number;
  stdout: CappedOutput;
  stderr: CappedOutput;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the spawn itself failed, so the record exists but the process does not. */
  error?: string;
  discardedBytes: number;
  /** Explicit lifecycle — kept in sync with `exited` for compatibility. */
  state?: ProcessState;
  pid?: number;
  /** Someone asked for it to stop (stop_subprocess, a restart under the same id): its end is not news. */
  stopRequested?: boolean;
}

type SubprocessLookup =
  | { sub: SubprocessRecord; result?: undefined }
  | { sub?: undefined; result: import('../../types.ts').ToolResult };

/** Find a live subprocess by id, or the refusal that says why there is none. stop_subprocess and subprocess_status ask exactly this question first. */
export function lookupSubprocess(
  ctx: import('../../types.ts').ToolContextInput,
  id: string
): SubprocessLookup {
  if (!id) return { result: fail('Missing subprocess id', { code: TOOL_ERROR_CODE.EINVAL }) };

  const registry = ctx?.state?.subprocesses;
  if (!registry) {
    return {
      result: fail('No subprocesses are tracked in this session', { code: TOOL_ERROR_CODE.EUNKNOWN }),
    };
  }

  const sub = registry.get(id);
  if (!sub) return { result: fail(`No subprocess with id "${id}"`, { code: TOOL_ERROR_CODE.ENOENT }) };

  return { sub };
}

/** An unsignaled nonzero exit means it died on its own — not that anyone stopped it. */
export function isCrashed(sub: SubprocessRecord): boolean {
  return sub.exited && sub.exitCode !== null && sub.exitCode !== 0 && !sub.signal;
}

export function readSubprocessOutput(sub: SubprocessRecord): { stdout: string; stderr: string } {
  return { stdout: readOutput(sub.stdout), stderr: readOutput(sub.stderr) };
}

export function clearSubprocessOutput(sub: SubprocessRecord): void {
  clearOutput(sub.stdout);
  clearOutput(sub.stderr);
}

/**
 * The agent is about to stop these processes itself. A subprocess of its own that is one of them, or that they run
 * under (a shell holding a dev server), ends on request: its end is not news. Marked before the kill, since the
 * subprocess can report its end before the kill returns.
 */
export function markStoppedByAgent(
  subprocesses: Map<string, SubprocessRecord> | undefined,
  lineages: Iterable<Set<number>>,
): void {
  if (!subprocesses?.size) return;
  const stopping = new Set<number>();
  for (const lineage of lineages) for (const pid of lineage) stopping.add(pid);
  for (const record of subprocesses.values()) {
    const pid = record.process?.pid ?? record.pid;
    if (pid && stopping.has(pid)) record.stopRequested = true;
  }
}
