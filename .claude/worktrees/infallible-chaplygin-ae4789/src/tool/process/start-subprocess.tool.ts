import { TOOL_ERROR_CODE } from '../../protocol';
import { exitedListenerNote } from './analysis/exited-listener';
import { detachReason } from './analysis/detach';
import { defineTool } from '../core/defineTool';
import { ok, fail } from '../core/tool-result';
import { resolveCallCwd } from './shell/runtime';
import { adoptSubprocess, awaitSpawn, awaitStartup, createSubprocess } from './lifecycle/spawn-subprocess';
import { readOutput } from './lifecycle/output-buffer';
import type { ToolContext, ToolResult } from '../../types';
import { killProcessTreeAndWait, processManager } from '../../env/process/index';
import { reportWhenEnded } from './background-inbox';
import { shellCommandRisk } from './shell/command-risk';

export default defineTool({
  name: 'start_subprocess',
  profiles: ['core'],
  category: 'process',
  activity: 'Starting a process',
  runsCode: true,
  label: 'Start Subprocess',
  risky: true,
  ...shellCommandRisk,
  description:
    'Start a command in a background subprocess that persists across tool calls: a server or watcher that never exits, ' +
    'or long finite work (a large build, docker build, a long test run) you want to run while you do other things. ' +
    'When it ends you are told in the session record — never poll subprocess_status waiting for it. ' +
    'Work whose result you need before your next step runs with exec_shell instead. ' +
    'Give it a stable id (or use the generated one); subprocess_status reads its output, stop_subprocess ends it.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run in the background (a server, watcher, or other never-exiting task)' },
      id: { type: 'string', description: 'Optional stable identifier. If omitted, one is generated.' },
      cwd: { type: 'string', pathArg: true, description: 'Working directory for this subprocess (workspace-relative)' },
    },
    required: ['command'],
  },
  // A job that finished while starting is one result, whatever id it was given: starting the same command again
  // under a new name found nothing new. A process still running has no key; each start of one is its own.

  preview(args) {
    return `start subprocess ${args?.id ?? ''}: ${String(args?.command ?? '').slice(0, 120)}`;
  },
  async execute(args, ctx) {
    return runInBackground(args, ctx);
  },
});

const TAIL_LINES = 30;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"]*/i;

/**
 * A foreground command is serving once it has printed a local address and then gone quiet while still running: it
 * will not exit on its own, so waiting for it holds the turn until the time limit. Seen by what it printed, not by
 * its name, so any server counts.
 */
export const SERVING = Object.freeze({ when: (output: string) => LOCAL_URL.test(output), quietMs: 2_000 });

/**
 * A foreground command that turned out to be serving keeps running as a background job: the same record, report on
 * exit and stop/status ids as start_subprocess, with what it printed so far as the result the model reacts to.
 */
export function keepServingInBackground(
  child: import('node:child_process').ChildProcess,
  { command, cwd, stdout, stderr }: { command: string; cwd: string; stdout: string; stderr: string },
  ctx: ToolContext,
): ToolResult {
  const state = ctx.state!;
  if (!state.subprocesses) state.subprocesses = new Map();
  const base = command.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'server';
  let id = base;
  for (let n = 2; state.subprocesses.has(id); n++) id = `${base}-${n}`;
  const sub = adoptSubprocess({ id, command, cwd, ownerId: state.sessionId, child, stdout, stderr, adopted: true });
  state.subprocesses.set(id, sub);
  if (state.background) reportWhenEnded(sub, state.background);
  const output = `${stdout}${stderr}`.trimEnd();
  const url = LOCAL_URL.exec(output)?.[0];
  const tail = output.split('\n').slice(-TAIL_LINES).join('\n');
  return ok({
    kind: 'command',
    display: [
      `\`${command}\` is serving${url ? ` at ${url}` : ''} and does not exit on its own, so it carries on in the background as "${id}" (pid ${child.pid})`,
      tail ? `Output so far:\n${tail}` : 'No output yet.',
      `When it ends you are told in the session record — do not poll. Read its output any time with subprocess_status {"id":"${id}"}; stop it with stop_subprocess {"id":"${id}"}.`,
    ].join('\n'),
    data: { id, pid: child.pid, command, cwd, background: true, ...(url ? { url } : {}) },
  });
}

/** Start a never-exiting command in the background, wait until it has started, and say plainly what happened. */
export async function runInBackground(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = String(args.command ?? '').trim();
  if (!command) return fail('Empty command', { code: TOOL_ERROR_CODE.EINVAL });
    const detached = detachReason(command);
    if (detached) {
      return fail(`Not run: ${detached}, where ocode could not see it, stop it or read its output (it would keep its port after the session).`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Run the program itself with start_subprocess (no start/Start-Process/nohup/&): it runs in the background, stays tracked, and its output and end are reported.',
      });
    }

  const state = ctx?.state;
  if (!state) {
    return fail('No session state is available to hold the subprocess', { code: TOOL_ERROR_CODE.EUNKNOWN });
  }
  if (!state.subprocesses) state.subprocesses = new Map();

  const id = String(args.id ?? `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  const existing = state.subprocesses.get(id);
  if (existing) {
    existing.stopRequested = true;
    await killProcessTreeAndWait(existing.process);
    processManager.untrackExternal(existing.process);
    state.subprocesses.delete(id);
  }

  const where = await resolveCallCwd(args, ctx);
  if (where.result) return where.result;

  const sub = createSubprocess({ id, command, cwd: where.cwd, ownerId: state.sessionId });
  state.subprocesses.set(id, sub);

  const spawnErr = await awaitSpawn(sub);
  if (spawnErr) {
    state.subprocesses.delete(id);
    processManager.untrackExternal(sub.process);
    return fail(`Failed to start "${command}": ${spawnErr.message}`, { code: TOOL_ERROR_CODE.EUNKNOWN, data: { id, command } });
  }

  const outcome = await awaitStartup(sub, ctx.signal);
  const output = `${readOutput(sub.stdout)}${readOutput(sub.stderr)}`.trimEnd();
  const tail = output.split('\n').slice(-TAIL_LINES).join('\n');
  const data = { id, pid: sub.process.pid, command, cwd: where.cwd, background: true };

  if (outcome === 'cancelled') {
    await killProcessTreeAndWait(sub.process);
    state.subprocesses.delete(id);
    return fail(`\`${command}\` was stopped because the turn was cancelled`, { code: TOOL_ERROR_CODE.ECANCELLED, data });
  }

  if (outcome === 'exited') {
    state.subprocesses.delete(id);
    if (sub.exitCode === 0) {
      // It said it was listening and is gone: whatever answers on that port now is another program, often an earlier
      // copy of this one, and the start failed to bind there without saying so.
      const exited = await exitedListenerNote(command, output);
      if (exited) {
        return {
          ...ok({
            kind: 'command',
            display: `\`${command}\` finished (exit 0) while starting. ${exited.display}\n${tail || '(no output)'}`,
            data: { ...data, exitCode: 0 },
          }),
          modelNote: exited.modelNote,
        };
      }
      return {
        ...ok({
          kind: 'command',
          display: `\`${command}\` finished (exit 0) while starting, so nothing is left running in the background\n${tail || '(no output)'}`,
          data: { ...data, exitCode: 0 },
        }),
        // The job the model meant to run alongside its other work is already done: this is its result.
        // Exiting by itself is the program's doing, not the tool's: a server that is listening does not exit.
        modelNote:
          'That job is complete — this output is its whole result. Starting it again, under any id, only repeats it. ' +
          'If it was meant to keep running (a server), it exited on its own: it is not listening. Read its code for why ' +
          '(the listen call is in another file or behind a condition, or it only exports the app) and start the file that ' +
          'actually listens; background jobs do keep running.',
      };
    }
    return fail(`\`${command}\` exited with code ${sub.exitCode ?? 'unknown'} before it was ready`, {
      code: TOOL_ERROR_CODE.EEXIT,
      display: tail || '(no output)',
      hint: 'Read the output above for the cause (a port already in use, a missing dependency), fix it, then start it again.',
      data: { ...data, exitCode: sub.exitCode },
    });
  }

  // From here it runs on its own: when it ends, the session is told, so nothing needs to poll for it.
  if (state.background) reportWhenEnded(sub, state.background);

  const url = LOCAL_URL.exec(output)?.[0];
  const head = url
    ? `Running in the background as "${id}" (pid ${sub.process.pid}) at ${url}`
    : outcome === 'settled'
      ? `Running in the background as "${id}" (pid ${sub.process.pid})`
      : `Started in the background as "${id}" (pid ${sub.process.pid}); still starting after 20s`;
  return ok({
    kind: 'command',
    display: [
      head,
      tail ? `Output so far:\n${tail}` : 'No output yet.',
      `It is still running. When it ends you are told in the session record — do not poll. ` +
        `Read its output any time with subprocess_status {"id":"${id}"}; stop it with stop_subprocess {"id":"${id}"}.`,
    ].join('\n'),
    data: { ...data, ...(url ? { url } : {}) },
  });
}
