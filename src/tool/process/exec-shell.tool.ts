import fs from 'node:fs';
import path from 'node:path';
import { defineTool } from '../core/defineTool';
import { ok, fail } from '../core/tool-result';
import { TOOL_ERROR_CODE } from '../../protocol';
import { logger } from '../../core/logger';
import { snapshotShellDeletes } from '../../core/session-recovery';
import { classifyRunCommand, deleteTargets, unbackupableDeleteReason } from '../policy/mutation-policy';
import { shellCommandRisk } from './shell/command-risk';

import { validateShellRequest } from './execution/request';
import { ownProcessStoppedBy, ownProcessRefusal } from './analysis/own-process';
import { executeShell } from './execution/execute';
import { runsToEnd } from './analysis/runs-to-end';
import { detachReason } from './analysis/detach';
import { projectDirsIn, projectFolderOf } from '../../env/project-layout';
import { noteWorkIn } from '../../context/workspace-state';
import { parseShellDiagnostics } from './analysis/diagnostics';
import { formatOutput } from './output/presentation';
import { runInBackground, keepServingInBackground, SERVING } from './background';
import type { ShellResult } from './types';

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
    'Run a shell command. Each call is a fresh shell; pass cwd to run elsewhere. background:true for a server, watcher or long job.',
  risky: true,
  // A command that only reads (ls, git status, a version check) runs without asking; anything else changes something.
  isRisky(args, where) {
    return classifyRunCommand(String(args?.command ?? ''), where?.cwd, where?.root, where?.cmd) === 'mutating';
  },
  description:
    'Run a shell command and return its stdout, stderr and exit code. Runs in the working project when the session record names one, else the workspace root; each call is a fresh shell, so "cd" does not carry over. Pass cwd to run somewhere else. ' +
    'It waits for the command to exit and gives it no stdin. A server, watcher or long job you do not need to wait for runs with background: true: the result says whether it came up, its URL and output so far, and the id for subprocess_status / stop_subprocess; when it ends you are told. ' +
    'To find files or search their contents, use the find_files and grep_content tools, not a recursive shell listing — they skip node_modules, build output and other system folders, while a raw recursive listing drowns the real matches in that noise. To process many files (count, group, compare, transform), use run_script.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', pathArg: true, description: 'A workspace-relative directory to run in for this call only. Leave it out to run in the working project (see the session record), or the workspace root when there is none.' },
      timeout_ms: { type: 'number', description: 'Time limit in ms. Leave it out in a chat: after 2 minutes the user is asked whether to keep waiting. With nobody to ask, the default is 120000.' },
      background: { type: 'boolean', description: 'Run it in the background and return once it has started (a server, watcher or long job).' },
    },
    required: ['command'],
  },
  runsCode: true,
  // What a finished run found: where, what, how it exited and what it reported. The raw output is not the key,
  // since a build or test prints its own timing and never reads the same twice.
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
      canAsk: typeof ctx.ask === 'function',
    });
    if ('error' in validation) return validation.error;
    // The person watches the command run: its output streams to the live window while the model waits for the result.
    const request = { ...validation.request, onOutput: ctx?.onCommandOutput };

    const detached = detachReason(command);
    if (detached) {
      return fail(`Not run: ${detached}, where ocode could not see it, stop it or read its output (it would keep its port after the session).`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Run the program itself with background: true (no start/Start-Process/nohup/&): it runs in the background, stays tracked, and its output and end are reported.',
      });
    }

    const own = await ownProcessStoppedBy(command);
    if (own) return ownProcessRefusal(own);

    logger.debug(`exec_shell: ${command} (cwd=${request.cwd}, timeout=${request.timeoutMs}ms)`);

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

    // A server, watcher or long job the model chose not to wait for: started, reported, and kept for subprocess_status.
    if (args.background === true) {
      return runInBackground(args, ctx);
    }

    // A command that turns out to be serving (it printed a local address and kept running) is handed over to the
    // background instead of holding the turn until the time limit. A test, build, lint or type-check run ends on its
    // own however long it is quiet, and its outcome is its exit code: it is never handed over.
    const endsOnItsOwn = runsToEnd(command);
    // Projects next to where it runs, before: one that appears (dotnet new … -o TodoApi) is where the work now is.
    // A test, build or lint run never makes a project: no folder scan for it.
    const projectsBefore = ctx?.state && !endsOnItsOwn ? new Set(projectDirsIn(request.cwd)) : null;
    const execution = await executeShell(ctx?.state && !endsOnItsOwn ? { ...request, release: SERVING } : request);
    if (ctx?.state && execution.exitCode === 0 && !execution.released) {
      const created = projectsBefore ? projectDirsIn(request.cwd).filter((dir) => !projectsBefore.has(dir)) : [];
      if (created.length === 1) noteWorkIn(ctx.state, created[0]);
      // A command run in a project's folder is work in that project.
      else if (args.cwd) noteWorkIn(ctx.state, projectFolderOf(ctx.state.root, request.cwd));
    }
    if (execution.released) {
      return keepServingInBackground(execution.released, { command, cwd: request.cwd, stdout: execution.stdout, stderr: execution.stderr }, ctx);
    }
    const diagnostics = await parseShellDiagnostics(execution.stdout, execution.stderr, {
      command,
      root: ctx?.state?.root,
      cwd: request.cwd,
    });

    if (execution.spawnError) {
      const isEnoent = /ENOENT/i.test(execution.spawnError.message);
      return fail(`Failed to start shell: ${execution.spawnError.message}`, {
        code: TOOL_ERROR_CODE.EUNKNOWN,
        hint: isEnoent ? 'The shell itself could not be launched. Verify that it is present.' : undefined,
        data: { command, cwd: request.cwd, stdout: execution.stdout, stderr: execution.stderr },
      });
    }

    const formatted = formatOutput({
      execution,
      command,
      diagnostics,
    });

    // Stopped or out of time, what it printed is still what happened: a test run that failed and then never exited
    // (an open handle) has its failures in this output, and without it the model is left to guess.
    if (execution.cancelled) {
      return fail('Command stopped before it exited', {
        code: TOOL_ERROR_CODE.ECANCELLED,
        display: formatted.presentation,
        data: { command, cwd: request.cwd, stdout: execution.stdout, stderr: execution.stderr, diagnostics },
      });
    }

    if (execution.timedOut) {
      return fail(`Command timed out after ${request.timeoutMs}ms`, {
        code: TOOL_ERROR_CODE.ETIMEDOUT,
        hint:
          'Pass a larger timeout_ms if it needs longer (a first .NET or Java build can take minutes). A command that waits ' +
          'for input never gets any here (stdin is closed), and a server or watcher never ends: run it with background: true.',
        display: formatted.presentation,
        data: { command, cwd: request.cwd, stdout: execution.stdout, stderr: execution.stderr, diagnostics },
      });
    }

    const truncated = formatted.truncated;
    // Where it ran, when that is not the workspace root: the folder the call did not name is part of what happened.
    const ranIn = ctx?.state?.root ? path.relative(ctx.state.root, request.cwd).split(path.sep).join('/') : '';
    const presentation = ranIn && !ranIn.startsWith('..') && !args.cwd ? `(in ${ranIn}/)\n${formatted.presentation}` : formatted.presentation;

    const fullData: ShellResult = {
      request,
      execution,
      diagnostics,
      presentation,
      truncated,
    };

    if (execution.exitCode === 0) {
      // A passing build, test, lint or type-check checks every change made before it.
      if (endsOnItsOwn && ctx?.state) ctx.state.verifiedAt = ctx.state.changeSeq ?? 0;
      return ok({
        kind: 'command',
        display: presentation,
        truncated,
        data: { ...fullData, ...(shellSnapshot?.group ? { undoableDelete: shellSnapshot.group } : {}) },
      });
    }

    const primary = diagnostics.find((d) => d.severity === 'error' || d.severity === 'failure');
    const failingLoc = primary?.file ? `${primary.file}${primary.line ? `:${primary.line}` : ''}` : '';
    const failingProject = primary?.project ? ` (in ${primary.project})` : '';
    const failingMsg = primary?.message ? ` — ${String(primary.message).slice(0, 120)}` : '';
    const exitMessage = primary && failingLoc
      ? `Command exited with code ${execution.exitCode} at ${failingLoc}${failingProject}${failingMsg}`
      : `Command exited with code ${execution.exitCode}`;

    return {
      ok: false,
      kind: 'command',
      display: presentation,
      truncated,
      error: exitMessage,
      code: TOOL_ERROR_CODE.EEXIT,
      data: fullData,
    };
  },
});
