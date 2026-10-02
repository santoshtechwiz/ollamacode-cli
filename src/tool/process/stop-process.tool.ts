import { TOOL_ERROR_CODE } from '../../protocol';

import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { describeProcess, isProtectedPid, lineageOf, listeningPids, listProcesses } from './processes/discovery';
import { markStoppedByAgent } from './subprocess-state';
import { isGone, killPid } from '../../env/process/index';
import { validateStopTarget } from './processes/validate-target';

export default defineTool({
  name: 'stop_process',
  profiles: ['core'],
  category: 'process',
  activity: 'Stopping a process',
  label: 'Stop Process',
  brief: 'Kill an OS process by pid, or whoever holds a port. Asks first; never pid 0/1/4 or self.',
  risky: true,
  description:
    'Stop an operating-system process the agent did not start — a stale server holding a port ' +
    '(EADDRINUSE), a runaway watcher, a previous session\u2019s leftover. Give exactly one of pid ' +
    'or port: a port resolves to whoever is listening on it. For servers started with ' +
    'start_subprocess, use stop_subprocess instead — it owns those handles. ' +
    'Protected targets (pid 0, 1, 4, and this process itself) are always refused.',
  parameters: {
    type: 'object',
    properties: {
      pid: { type: 'number', description: 'Process id to stop' },
      port: { type: 'number', description: 'Stop whoever is listening on this TCP port' },
    },
    requiredOneOf: [['pid'], ['port']],
  },
  volatile: true,

  preview(args) {
    const pid = args?.pid !== undefined && args.pid !== null ? String(args.pid) : null;
    const port = args?.port !== undefined && args.port !== null ? String(args.port) : null;
    if (port !== null) return `stop whoever holds port ${port}`;
    return `stop process ${pid ?? '(no target)'}`;
  },
  async execute(args, ctx) {
    try {
      const target = validateStopTarget(args ?? {});
      if ('error' in target) {
        return fail(target.error.message, { code: TOOL_ERROR_CODE.EINVAL, hint: target.error.hint });
      }

      let pids: number[];
      const port = target.kind === 'port' ? target.port : null;
      if (target.kind === 'port') {
        try {
          pids = await listeningPids(target.port);
        } catch (err) {
          return fail(`Could not list listeners on port ${target.port}: ${(err as Error).message}`, {
            code: TOOL_ERROR_CODE.EUNKNOWN,
            hint: 'Fall back to a shell query (netstat -ano | findstr :PORT, or ss -ltnp) and pass an explicit pid.',
          });
        }
        if (pids.length === 0) {
          return fail(`Nothing is listening on port ${target.port}`, {
            code: TOOL_ERROR_CODE.ENOENT,
            hint: 'The port is already free — retry the command that failed with EADDRINUSE.',
          });
        }
      } else {
        pids = [target.pid];
      }

      for (const pid of pids) {
        if (isProtectedPid(pid)) {
          return fail(`Refusing to stop PID ${pid}: system process or this agent itself`, {
            code: TOOL_ERROR_CODE.EINVAL,
            hint: 'Nothing was stopped. Pick a different target.',
          });
        }
      }

      // The shell and terminal this agent runs under: stopping one ends the agent with it.
      const processes = await listProcesses();
      const above = lineageOf(process.pid, processes);
      const parent = pids.find((pid) => above.has(pid));
      if (parent !== undefined) {
        return fail(`Refusing to stop PID ${parent}: this agent runs under it, so stopping it would end this session`, {
          code: TOOL_ERROR_CODE.EINVAL,
          hint: 'Nothing was stopped. Pick a different target.',
        });
      }

      const own = ctx?.state?.subprocesses;
      if (own?.size) markStoppedByAgent(own, pids.map((pid) => lineageOf(pid, processes)));

      const outcomes: { pid: number; image: string; stopped: boolean }[] = [];
      for (const pid of pids) {
        const described = await describeProcess(pid);
        if (!described) {
          outcomes.push({ pid, image: '(already gone)', stopped: true });
          continue;
        }
        try {
          // killPid escalates SIGTERM → SIGKILL and throws when the process survives.
          await killPid(pid);
        } catch (err) {
          return fail(`Could not stop PID ${pid} (${described.image}): ${(err as Error).message}`, {
            code: TOOL_ERROR_CODE.EUNKNOWN,
            hint: 'The process may need elevation — report this and stop, do not retry blindly.',
          });
        }
        outcomes.push({ pid, image: described.image, stopped: isGone(pid) });
      }
      const survivors = outcomes.filter((o) => !o.stopped && !isGone(o.pid));
      if (survivors.length > 0) {
        return fail(
          `Stopped ${outcomes.length - survivors.length} of ${outcomes.length}, but still running: ` +
            survivors.map((o) => `PID ${o.pid} (${o.image})`).join(', '),
          { code: TOOL_ERROR_CODE.EUNKNOWN }
        );
      }
      const lines = outcomes.map((o) =>
        o.image === '(already gone)' ? `PID ${o.pid} — already gone` : `Stopped PID ${o.pid} (${o.image})`
      );
      return ok({
        kind: 'command',
        display:
          (port !== null ? `Port ${port} is free.\n` : '') +
          lines.join('\n') +
          (port !== null ? `\nRetry the command that failed with EADDRINUSE.` : ''),
        data: { pids, port, outcomes },
      });
    } catch (err) {
      return fromError(err);
    }
  },
});
