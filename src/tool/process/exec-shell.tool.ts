import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '../core/defineTool';
import { ok, fail } from '../core/tool-result';
import { TOOL_ERROR_CODE } from '../../protocol';
import { logger } from '../../core/logger';
import { snapshotShellDeletes } from '../../core/session-recovery';
import { deleteTargets, unbackupableDeleteReason } from '../policy/mutation-policy';
import { shellCommandRisk } from './shell/command-risk';

import { validateShellRequest } from './execution/request';
import { ownProcessStoppedBy, ownProcessRefusal } from './analysis/own-process';
import { executeShell } from './execution/execute';
import { classifyCommand } from './analysis/classify-command';
import { parseShellDiagnostics } from './analysis/diagnostics';
import { createVerificationMetadata, updateVerificationWithRecovery } from './analysis/verification';
import { attemptRecovery, retryAfterRecovery } from './recovery/recovery';
import { generateHints } from './hints/command-hints';
import { formatOutput } from './output/presentation';
import { runInBackground } from './start-subprocess.tool';
import type { ShellResult } from './types';

const background =
  'Nothing here is a bug in the program. To exercise a server or an interactive app, ' +
  'start it with start_subprocess, drive it with separate calls, then stop_subprocess. ' +
  'To check that it merely builds, run the build/test command instead (e.g. dotnet build, dotnet test).';

export default defineTool({
  name: 'exec_shell',
  aliases: ['run_command', 'bash', 'shell', 'sh', 'exec', 'execute_command', 'terminal'],
  argAliases: {
    cmd: 'command',
    script: 'command',
    shell_command: 'command',
  },
  profiles: ['core'],
  category: 'process',
  activity: 'Running a command',
  label: 'Exec Shell',
  brief:
    'Run a shell command to completion. Each call is a fresh shell; pass cwd to run elsewhere. Dev servers and watchers start in the background automatically.',
  risky: true,
  description:
    'Run a shell command and return its stdout, stderr and exit code. Runs from the workspace root; each call is a fresh shell, so "cd" does not carry over. Pass cwd to run somewhere else. ' +
    'It waits for the command to exit and gives it no stdin. A recognised dev server or watcher (npm run dev, vite, dotnet run, uvicorn…) is started in the background instead: the result says whether it came up, its URL and output so far, and the id for subprocess_status / stop_subprocess. Anything else that never exits or asks a question will not return here — start it with start_subprocess. ' +
    'To find files or search their contents, use the find_files and grep_content tools, not a recursive shell listing — they skip node_modules, build output and other system folders, while a raw recursive listing drowns the real matches in that noise. To process many files (count, group, compare, transform), use run_script.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', pathArg: true, description: 'A workspace-relative directory to run in for this call only. Leave it out to run from the workspace root.' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000)' },
    },
    required: ['command'],
  },
  volatile: true,
  runsCode: true,
  // What a finished run found: where, what, how it exited and what it reported. The raw output is not the key,
  // since a build or test prints its own timing and never reads the same twice.
  resultKey(result) {
    const data = result.data as Partial<ShellResult> | undefined;
    if (!data?.request || !data.execution) return undefined;
    const findings = (data.diagnostics ?? []).map((d) => `${d.severity} ${d.file}:${d.line ?? ''} ${d.message}`).sort();
    return [data.request.cwd, data.request.command, data.execution.exitCode, ...findings].join('\u0000');
  },
  ...shellCommandRisk,
  wouldWrite(args) {
    return (deleteTargets(String(args?.command ?? '')) ?? []).map((p) => ({ path: p, after: () => null }));
  },
  preview(args) {
    return `run: ${String(args?.command ?? '').slice(0, 160)}`;
  },
  async execute(args, ctx): Promise<ReturnType<typeof ok> | ReturnType<typeof fail>> {
    const command = String(args.command ?? '').trim();
    if (!command) return fail('Empty command', { code: TOOL_ERROR_CODE.EINVAL });

    const validation = await validateShellRequest(args, {
      cwd: ctx.cwd,
      root: ctx.root,
      state: ctx.state,
      signal: ctx.signal,
    });
    if ('error' in validation) return validation.error;
    const request = validation.request;

    const own = await ownProcessStoppedBy(command);
    if (own) return ownProcessRefusal(own);

    logger.debug(`exec_shell: ${command} (cwd=${request.cwd}, timeout=${request.timeoutMs}ms)`);

    // A dev server or watcher never exits, so waiting on it hangs the turn: run it in the background and report how it started.
    if (classifyCommand(command).category === 'server') {
      const id = command.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || undefined;
      return runInBackground({ ...args, id }, ctx);
    }

    const unbackupable = unbackupableDeleteReason(command, request.cwd);
    if (unbackupable) {
      return fail(`exec_shell did not run — this delete cannot be backed up: ${unbackupable}`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint:
          'Name the paths explicitly so they can be copied first (rm -rf build, del build\\x), ' +
          'or list what it would remove (git clean -n, find . -name "*.tmp") and delete those paths with the file tools, ' +
          'which snapshot every file they remove.',
      });
    }

    const deletedTargetsList = deleteTargets(command);
    const existedBefore = (deletedTargetsList ?? []).filter((t) => {
      try {
        return fs.existsSync(path.resolve(request.cwd, t));
      } catch {
        return true;
      }
    });

    let shellSnapshot: { snapshotted: number; unrestorable: number; group?: string } | null = null;
    if (existedBefore.length > 0) {
      try {
        shellSnapshot = await snapshotShellDeletes({
          root: request.cwd,
          sessionId: ctx?.state?.sessionId,
          tool: 'exec_shell',
          command,
        });
      } catch {
        shellSnapshot = null;
      }
    }

    let execution = await executeShell(request);
    let classification = classifyCommand(command);
    let diagnostics = await parseShellDiagnostics(execution.stdout, execution.stderr, {
      command,
      root: ctx?.state?.root,
      cwd: request.cwd,
    });
    let verification = createVerificationMetadata({ execution, classification, diagnostics });
    let recovery = await attemptRecovery({ execution, classification, request, ctx });

    if (recovery.attempted && recovery.kind === 'file-lock' && recovery.succeeded === null) {
      const retryResult = await retryAfterRecovery(request, executeShell);
      execution = retryResult.execution;
      recovery = {
        ...recovery,
        succeeded: retryResult.recoverySucceeded,
        detail: retryResult.recoverySucceeded
          ? `Recovered from a file-lock: ${recovery.detail} Retried once after safe recovery and the retry passed.`
          : recovery.detail,
      };
      classification = classifyCommand(command);
      diagnostics = await parseShellDiagnostics(execution.stdout, execution.stderr, {
        command,
        root: ctx?.state?.root,
        cwd: request.cwd,
      });
      verification = createVerificationMetadata({ execution, classification, diagnostics });
      verification = updateVerificationWithRecovery(verification, true, retryResult.recoverySucceeded);
    }

    if (execution.spawnError) {
      const isEnoent = /ENOENT/i.test(execution.spawnError.message);
      return fail(`Failed to start shell: ${execution.spawnError.message}`, {
        code: TOOL_ERROR_CODE.EUNKNOWN,
        hint: isEnoent ? 'The shell itself could not be launched. Verify that it is present.' : undefined,
        data: { command, cwd: request.cwd, stdout: execution.stdout, stderr: execution.stderr },
      });
    }

    if (execution.cancelled) {
      return fail('Command cancelled', { code: TOOL_ERROR_CODE.ECANCELLED, data: { command, cwd: request.cwd } });
    }

    if (execution.timedOut) {
      const isWaitingForInput = /\b(?:enter|choose|select|press|type|input|password|continue\?|y\/n)\b[^\n]{0,40}$/i.test(execution.stdout.trimEnd());
      if (isWaitingForInput) {
        return fail(
          `Stopped after ${request.timeoutMs}ms: the command is waiting for input, which never arrives — exec_shell closes stdin`,
          { code: TOOL_ERROR_CODE.EINTERACTIVE, hint: background, data: { command, cwd: request.cwd } }
        );
      }
      const serverStarted = /\b(?:listening|serving|started)\b[^\n]{0,100}(?:\bport\s*\d+\b|https?:\/\/\S+|:\d{2,5}\b)/i.test(execution.stdout);
      if (serverStarted) {
        return fail('The command started a server or watcher and did not exit; use start_subprocess instead.', {
          code: TOOL_ERROR_CODE.EINTERACTIVE,
          hint: background,
          data: { command, cwd: request.cwd, serverStarted: true, useSubprocess: true },
        });
      }
      return fail(`Command timed out after ${request.timeoutMs}ms`, {
        code: TOOL_ERROR_CODE.ETIMEDOUT,
        hint: 'Pass a larger timeout_ms (e.g. 300000 for .NET/Java projects that compile on first run), or run a faster command.',
        data: { command, cwd: request.cwd },
      });
    }

    const serverDetected = /\b(?:listening|serving|started)\b[^\n]{0,100}(?:\bport\s*\d+\b|https?:\/\/\S+|:\d{2,5}\b)/i.test(execution.stdout);
    if (serverDetected) {
      return fail('The command started a server or watcher and did not exit; use start_subprocess instead.', {
        code: TOOL_ERROR_CODE.EINTERACTIVE,
        hint: background,
        data: { command, cwd: request.cwd, serverStarted: true, useSubprocess: true },
      });
    }

    const hints = generateHints({ execution, classification, verification, recovery, request });

    const { presentation, truncated } = formatOutput({
      execution,
      hints,
      command,
      diagnostics,
    });

    const fullData: ShellResult = {
      request,
      execution,
      classification,
      verification,
      diagnostics,
      hints,
      recovery,
      presentation,
      truncated,
    };

    const nothingToDelete =
      deletedTargetsList !== null &&
      existedBefore.length === 0 &&
      (deletedTargetsList.every((t) => {
        try {
          return !fs.existsSync(path.resolve(request.cwd, t));
        } catch {
          return false;
        }
      }) || deleteFoundNothing(execution.stderr, deletedTargetsList));

    if (execution.exitCode !== 0 && nothingToDelete) {
      const one = deletedTargetsList && deletedTargetsList.length === 1 ? deletedTargetsList[0] : null;
      const verdict = one
        ? `Already gone — ${one} was not there, so there was nothing to remove.`
        : 'Already gone — none of those paths existed, so there was nothing to remove.';
      return ok({
        kind: 'command',
        display: `$ ${command}\n${verdict}`,
        truncated: false,
        data: { ...fullData, deletedNothing: true },
      });
    }

    const absenceMatch = execution.exitCode === 1 && !execution.stdout.trim() && !execution.stderr.trim() && /^\s*(Get-Process|Get-NetTCPConnection|Get-Service|pgrep|pidof)\b[^|;&]*$/i.exec(command);
    if (absenceMatch) {
      const noun = { 'get-process': 'process', 'get-nettcpconnection': 'connection', 'get-service': 'service', pgrep: 'process', pidof: 'process' }[absenceMatch[1].toLowerCase()] ?? 'target';
      return ok({
        kind: 'command',
        display: `${presentation}\nNo match — the queried ${noun} is not present.`,
        truncated,
        data: { ...fullData, absenceProbe: true },
      });
    }

    if (execution.exitCode === 0 && recovery.attempted && recovery.succeeded === true) {
      return ok({ kind: 'command', display: `${presentation}\n[recovery]\n${recovery.detail}`, truncated, data: fullData });
    }

    if (execution.exitCode === 0) {
      return ok({
        kind: 'command',
        display: presentation,
        truncated,
        data: { ...fullData, ...(shellSnapshot?.group ? { undoableDelete: shellSnapshot.group } : {}) },
      });
    }

    const primary = verification.primaryDiagnostic;
    const failingLoc = primary?.file ? `${primary.file}${primary.line ? `:${primary.line}` : ''}` : '';
    const failingProject = primary?.project ? ` (in ${primary.project})` : '';
    const failingMsg = primary?.message ? ` — ${String(primary.message).slice(0, 120)}` : '';
    const exitMessage = primary && failingLoc
      ? `Command exited with code ${execution.exitCode} at ${failingLoc}${failingProject}${failingMsg}`
      : `Command exited with code ${execution.exitCode}`;

    const recoveryHint = recovery.attempted && recovery.kind === 'file-lock' && recovery.succeeded === false
      ? recovery.detail
      : null;

    return {
      ok: false,
      kind: 'command',
      display: recoveryHint ? `${presentation}\n[recovery]\n${recoveryHint}` : presentation,
      truncated,
      error: recovery.attempted && recovery.kind === 'file-lock' && recovery.succeeded === false
        ? `Build blocked by a locked file — stale process, not a source error`
        : exitMessage,
      hint: recoveryHint ?? undefined,
      code: TOOL_ERROR_CODE.EEXIT,
      data: fullData,
    };
  },
});

function deleteFoundNothing(stderr: string, targets: string[] | null): boolean {
  if (!targets?.length) return false;
  const lines = String(stderr ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((line) => /cannot find path|does not exist|no such file or directory|could not find|cannot find the (?:file|path) specified|ItemNotFoundException/i.test(line)) &&
    targets.every((target) => {
      const leaf = target.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? '';
      return leaf.length > 0 && lines.some((l) => l.toLowerCase().includes(leaf));
    });
}