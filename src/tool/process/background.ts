import { describeListening, listeningPorts } from './analysis/listening-ports';
import { TOOL_ERROR_CODE } from '../../protocol';
import { ok, fail } from '../core/tool-result';
import { resolveCallCwd } from './shell/runtime';
import { adoptSubprocess, awaitSpawn, awaitStartup, createSubprocess } from './lifecycle/spawn-subprocess';
import { readOutput } from './lifecycle/output-buffer';
import type { ToolContext, ToolResult } from '../../types';
import { killProcessTreeAndWait, processManager } from '../../env/process/index';
import { reportWhenEnded } from './background-inbox';

const TAIL_LINES = 30;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"]*/i;

/**
 * A foreground command is serving once it has printed a local address and then gone quiet while still running: it
 * will not exit on its own, so waiting for it holds the turn until the time limit. Seen by what it printed, not by
 * its name, so any server counts.
 */
export const SERVING = Object.freeze({ when: (output: string) => LOCAL_URL.test(output), quietMs: 2_000 });

/**
 * A job's id: the command as a slug, numbered when a job by that name is already held. Starting a command again
 * starts a second job beside the first, never in place of it; stopping one is stop_subprocess's job.
 */
function freeJobId(base: string, taken: ReadonlyMap<string, unknown>): string {
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';
  let id = slug;
  for (let n = 2; taken.has(id); n++) id = `${slug}-${n}`;
  return id;
}

/**
 * A foreground command that turned out to be serving keeps running as a background job: the same record, report on
 * exit and stop/status ids as a background job started on purpose, with what it printed so far as the result the model reacts to.
 */
export function keepServingInBackground(
  child: import('node:child_process').ChildProcess,
  { command, cwd, stdout, stderr }: { command: string; cwd: string; stdout: string; stderr: string },
  ctx: ToolContext,
): ToolResult {
  const state = ctx.state!;
  if (!state.subprocesses) state.subprocesses = new Map();
  const id = freeJobId(command, state.subprocesses);
  const sub = adoptSubprocess({ id, command, cwd, child, stdout, stderr, adopted: true });
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

  const state = ctx?.state;
  if (!state) {
    return fail('No session state is available to hold the subprocess', { code: TOOL_ERROR_CODE.EUNKNOWN });
  }
  if (!state.subprocesses) state.subprocesses = new Map();

  const id = freeJobId(typeof args.id === 'string' && args.id ? args.id : command, state.subprocesses);

  const where = await resolveCallCwd(args, ctx);
  if (where.result) return where.result;

  const sub = createSubprocess({ id, command, cwd: where.cwd });
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
      return ok({
        kind: 'command',
        display: `\`${command}\` finished (exit 0) while starting, so nothing is left running in the background\n${tail || '(no output)'}`,
        data: { ...data, exitCode: 0 },
      });
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

  const printed = LOCAL_URL.exec(output)?.[0];
  // Where it really listens, asked of the system: what it printed can be missing (still starting) or out of date.
  const ports = await listeningPorts(sub.process.pid);
  const url = ports?.length ? `http://localhost:${ports[0]}` : printed;
  const listening = describeListening(ports);
  const head = url
    ? `Running in the background as "${id}" (pid ${sub.process.pid}) at ${url}`
    : outcome === 'settled'
      ? `Running in the background as "${id}" (pid ${sub.process.pid})`
      : `Started in the background as "${id}" (pid ${sub.process.pid}); still starting after 20s`;
  return ok({
    kind: 'command',
    display: [
      head,
      ...(listening ? [listening] : []),
      tail ? `Output so far:\n${tail}` : 'No output yet.',
      `It is still running. When it ends you are told in the session record — do not poll. ` +
        `Read its output any time with subprocess_status {"id":"${id}"}; stop it with stop_subprocess {"id":"${id}"}.`,
    ].join('\n'),
    data: { ...data, ...(url ? { url } : {}), ...(ports ? { ports } : {}) },
  });
}
