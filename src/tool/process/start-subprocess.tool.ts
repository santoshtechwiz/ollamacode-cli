import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail } from '../core/tool-result';
import { resolveCallCwd } from './shell/runtime';
import { awaitSpawn, awaitStartup, createSubprocess } from './lifecycle/spawn-subprocess';
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
  volatile: true,
  // A job that finished while starting is one result, whatever id it was given: starting the same command again
  // under a new name found nothing new. A process still running has no key; each start of one is its own.
  resultKey(result) {
    const data = result.data as { command?: string; exitCode?: number | null; background?: boolean } | undefined;
    return data?.background && data.exitCode !== undefined ? `${data.command}\u0000${data.exitCode}` : undefined;
  },

  preview(args) {
    return `start subprocess ${args?.id ?? ''}: ${String(args?.command ?? '').slice(0, 120)}`;
  },
  async execute(args, ctx) {
    return runInBackground(args, ctx);
  },
});

const TAIL_LINES = 30;
const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d+)?[^\s'"]*/i;

/** Start a never-exiting command in the background, wait until it has started, and say plainly what happened. */
export async function runInBackground(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const command = String(args.command ?? '').trim();
  if (!command) return fail('Empty command', { code: TOOL_ERROR_CODE.EINVAL });

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
      return {
        ...ok({
          kind: 'command',
          display: `\`${command}\` finished (exit 0) while starting, so nothing is left running in the background\n${tail || '(no output)'}`,
          data: { ...data, exitCode: 0 },
        }),
        // The job the model meant to run alongside its other work is already done: this is its result.
        modelNote: 'That job is complete — this output is its whole result. Starting it again, under any id, only repeats it.',
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
      `It keeps running. When it ends you are told in the session record — do not poll. ` +
        `Read its output any time with subprocess_status {"id":"${id}"}; stop it with stop_subprocess {"id":"${id}"}.`,
    ].join('\n'),
    data: { ...data, ...(url ? { url } : {}) },
  });
}
