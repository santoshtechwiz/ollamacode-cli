import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail } from '../core/tool-result';
import { isCrashed, lookupSubprocess, readSubprocessOutput } from './subprocess-state';
import { killProcessTreeAndWait, processManager } from '../../env/process/index';

export default defineTool({
  name: 'stop_subprocess',
  profiles: ['core'],
  category: 'process',
  activity: 'Stopping a process',
  label: 'Stop Subprocess',
  risky: true,
  description:
    'Stop a background subprocess started with start_subprocess. Returns the final exit code and any remaining output.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Subprocess id returned by start_subprocess' },
    },
    required: ['id'],
  },

  preview(args) {
    return `stop subprocess: ${args?.id}`;
  },
  async execute(args, ctx) {
    const id = String(args.id ?? '');
    const found = lookupSubprocess(ctx, id);
    if (found.result) return found.result;
    const sub = found.sub;
    const registry = ctx.state!.subprocesses;

    if (sub.error) {
      processManager.untrackExternal(sub.process);
      registry.delete(id);
      return fail(`Subprocess "${id}" failed to start: ${sub.error}`, {
        code: TOOL_ERROR_CODE.EUNKNOWN,
        data: { id },
      });
    }

    const stoppedByUs = !sub.exited;
    // Asked for, so its end is not news to report.
    sub.stopRequested = true;
    if (stoppedByUs) {
      // Wait for the real death, bounded by the kill grace — never a fixed sleep.
      await killProcessTreeAndWait(sub.process);
    }

    const { stdout, stderr } = readSubprocessOutput(sub);
    const shown = [
      stdout.slice(0, 2_000) && `[stdout]\n${stdout.slice(0, 2_000)}\n`,
      stderr.slice(0, 2_000) && `[stderr]\n${stderr.slice(0, 2_000)}`,
    ]
      .filter(Boolean)
      .join('');

    processManager.untrackExternal(sub.process);
    registry.delete(id);

    const outcome = {
      id,
      exitCode: sub.exitCode,
      signal: sub.signal,
      stdout,
      stderr,
    };
    // A process we just killed reports a non-zero exit on Windows; that is the stop, not a crash.
    if (!stoppedByUs && isCrashed(sub)) {
      return {
        ok: false,
        kind: 'command',
        code: TOOL_ERROR_CODE.EEXIT,
        error: `Subprocess "${id}" had already exited with code ${sub.exitCode} before it was stopped`,
        display:
          `Subprocess "${id}" had already crashed (exit ${sub.exitCode})\n` +
          (shown || '(no output)'),
        data: outcome,
      };
    }

    return ok({
      kind: 'command',
      display:
        `Stopped subprocess "${id}"${!stoppedByUs && sub.exitCode !== null ? ` (it had exited with code ${sub.exitCode})` : ''}\n` +
        (shown || '(no output)'),
      data: outcome,
    });
  },
});
