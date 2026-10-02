import path from 'node:path';
import { logger } from '../../../core/logger';
import { fileLockedLines, portInUseLines, saysFileLocked, saysPortInUse } from '../command-messages';
import { isGone, killPid, waitForExit } from '../../../env/process/index';
import { lineageOf, listProcesses } from '../processes/discovery';
import { markStoppedByAgent, type SubprocessRecord } from '../subprocess-state';
import {
  attributeProcesses,
  candidatesForLock,
  isProtectedPid,
  type ProcessInfo,
} from '../processes/attribution';
import type { ShellExecutionResult, CommandClassification, RecoveryResult, ShellRequest } from '../types';

const MAX_EVIDENCE_LINES = 4;
const MAX_LOCKED_FILES = 5;

function firstLines(text: string, max: number): string[] {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max);
}

function extractLockedFiles(output: string): string[] {
  const text = String(output ?? '');
  const found: string[] = [];
  const push = (p: string) => {
    const clean = String(p ?? '').trim().replace(/^["']|["']$/g, '');
    if (!clean || found.includes(clean) || found.length >= MAX_LOCKED_FILES) return;
    if (/\.(exe|dll)$/i.test(clean) || /[\\/]bin[\\/]/i.test(clean)) found.push(clean);
  };
  for (const m of text.matchAll(/["'`]([^"'`]*\.(?:exe|dll))["'`]/gi)) push(m[1]);
  for (const m of text.matchAll(/((?:[A-Za-z]:)?[\\\w.\-\\/]*[\\/]bin[\\\w.\-\\/]*\.(?:exe|dll))/gi)) push(m[1]);
  for (const m of text.matchAll(/to\s+["'`]?([^"'`\n]*\.(?:exe|dll))["'`]?/gi)) push(m[1]);
  return found;
}

function detectFileLock(output: string): { confidence: 'high' | 'medium' | 'low'; evidence: string[] } | null {
  const text = String(output ?? '');
  const evidence: string[] = [];
  if (/MSB3021|MSB3027/i.test(text)) {
    evidence.push(...firstLines(text.match(/.*MSB302[17].*/gi)?.join('\n') ?? '', MAX_EVIDENCE_LINES));
    return { confidence: 'high', evidence };
  }
  if (saysFileLocked(text) && (/\.(exe|dll)\b/i.test(text) || /text file busy|ETXTBSY/i.test(text))) {
    evidence.push(...firstLines(fileLockedLines(text).join('\n'), MAX_EVIDENCE_LINES));
    return { confidence: 'high', evidence };
  }
  return null;
}

function detectPortInUse(output: string, command: string): { port: number | null; evidence: string[] } | null {
  const text = `${output}\n${command}`;
  if (!saysPortInUse(text)) return null;
  const port = /:(\d{2,5})\b/.exec(text)?.[1] ?? null;
  return {
    port: port !== null ? Number(port) : null,
    evidence: firstLines(portInUseLines(String(output)).join('\n'), 2),
  };
}

function ownSubprocessPids(state?: { subprocesses?: Map<string, { process?: { pid?: number } }> }): number[] {
  const pids: number[] = [];
  try {
    for (const record of state?.subprocesses?.values() ?? []) {
      const pid = (record?.process as { pid?: number } | undefined)?.pid;
      if (Number.isInteger(pid) && (pid as number) > 0) pids.push(pid as number);
    }
  } catch {
  }
  return pids;
}

async function attemptFileLockRecovery(
  lockedFiles: string[],
  root: string,
  state?: { subprocesses?: Map<string, { process?: { pid?: number } }> }
): Promise<RecoveryResult> {
  const locked = lockedFiles.slice(0, MAX_LOCKED_FILES);
  let processes: ProcessInfo[] = [];
  try {
    processes = await listProcesses();
  } catch (err) {
    logger.debug('file-lock recovery: process list unavailable', err);
  }
  const ownPids = ownSubprocessPids(state);
  const rootHints = locked
    .map((f) => path.win32.basename(String(f)).replace(/\.(exe|dll)$/i, '').toLowerCase())
    .filter(Boolean);
  const candidates = candidatesForLock(processes, locked).filter((p) => !isGone(p.pid));
  const attributed = attributeProcesses(candidates, { root, ownPids, rootHints });

  const killed: { pid: number; image: string }[] = [];
  const unsafe: { pid: number; image: string; reason: string }[] = [];
  for (const { proc, safeReason } of attributed) {
    if (isProtectedPid(proc.pid)) {
      unsafe.push({ pid: proc.pid, image: proc.image, reason: 'protected system/agent process' });
      continue;
    }
    if (!safeReason) {
      unsafe.push({
        pid: proc.pid,
        image: proc.image,
        reason: 'image name matches but nothing ties it to this project — approval required',
      });
      continue;
    }
    try {
      markStoppedByAgent(state?.subprocesses as Map<string, SubprocessRecord> | undefined, [lineageOf(proc.pid, processes)]);
      await killPid(proc.pid);
      const exited = await waitForExit(proc.pid, 5000);
      if (exited || isGone(proc.pid)) {
        killed.push({ pid: proc.pid, image: proc.image });
        logger.debug(`file-lock recovery: stopped PID ${proc.pid} (${proc.image}) — ${safeReason}`);
      } else {
        unsafe.push({ pid: proc.pid, image: proc.image, reason: 'did not exit after stop — approval required' });
      }
    } catch (err) {
      unsafe.push({
        pid: proc.pid,
        image: proc.image,
        reason: `stop failed (${(err as Error)?.message ?? 'unknown'}) — may need elevation`,
      });
    }
  }

  const approvalNeeded = killed.length === 0;
  const approvalPid = approvalNeeded ? (unsafe[0]?.pid ?? undefined) : undefined;
  const detail =
    killed.length > 0
      ? `Stopped ${killed.map((k) => `PID ${k.pid} (${k.image})`).join(', ')}.`
      : unsafe.length > 0
        ? `No process could be safely attributed to this project. Candidate holder: PID ${unsafe[0]?.pid} (${unsafe[0]?.image}) — ${unsafe[0]?.reason}.`
        : 'No live holder found — the lock may already be released; a single retry is safe.';

  return {
    kind: 'file-lock',
    attempted: true,
    succeeded: null,
    detail,
    killedPids: killed.map((k) => k.pid),
    requiresApproval: approvalNeeded,
    approvalPid,
  };
}

async function attemptPortInUseRecovery(port: number): Promise<RecoveryResult> {
  return {
    kind: 'port-in-use',
    attempted: false,
    succeeded: null,
    detail: `Port ${port} is held by another process. Stop the holder first, then retry.`,
    killedPids: [],
    requiresApproval: true,
    approvalPid: undefined,
  };
}

export async function attemptRecovery(input: {
  execution: ShellExecutionResult;
  classification: CommandClassification;
  request: ShellRequest;
  ctx: { state?: { subprocesses?: Map<string, { process?: { pid?: number } }> }; root?: string };
}): Promise<RecoveryResult> {
  const { execution, request, ctx } = input;

  if (execution.timedOut || execution.cancelled || execution.spawnError || execution.exitCode === 0) {
    return { kind: 'none', attempted: false, succeeded: null, detail: '', killedPids: [], requiresApproval: false };
  }

  const output = `${execution.stdout}\n${execution.stderr}`;
  const fileLock = detectFileLock(output);
  if (fileLock) {
    const lockedFiles = extractLockedFiles(output);
    return attemptFileLockRecovery(lockedFiles, ctx.root ?? request.cwd, ctx.state);
  }

  const port = detectPortInUse(output, request.command);
  if (port) {
    return attemptPortInUseRecovery(port.port ?? 0);
  }

  return { kind: 'none', attempted: false, succeeded: null, detail: '', killedPids: [], requiresApproval: false };
}

export async function retryAfterRecovery(
  request: ShellRequest,
  executeFn: (req: ShellRequest) => Promise<ShellExecutionResult>
): Promise<{ execution: ShellExecutionResult; recoverySucceeded: boolean }> {
  const execution = await executeFn(request);
  const recoverySucceeded = execution.exitCode === 0 && !execution.timedOut && !execution.cancelled;
  return { execution, recoverySucceeded };
}