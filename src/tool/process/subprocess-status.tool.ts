import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail } from '../core/tool-result';
import {
  clearSubprocessOutput,
  isCrashed,
  lookupSubprocess,
  readSubprocessOutput,
} from './subprocess-state';

const MAX_OUTPUT_CHARS = 4_000;

export default defineTool({
  name: 'subprocess_status',
  profiles: ['core'],
  category: 'process',
  activity: 'Checking a process',
  label: 'Subprocess Status',
  description:
    'Check whether a background subprocess is still running and read its recent stdout/stderr. ' +
    'Use this after start_subprocess to wait for a server to be ready or to inspect logs. ' +
    'Pass clear:true once you have read the output so the next poll returns only what is new. ' +
    'Do not poll the same id in a tight loop: if two checks show it running with no new output, stop polling and do other work instead.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Subprocess id returned by start_subprocess' },
      clear: { type: 'boolean', description: 'Clear buffered output after reading it, so the next poll returns only new output' },
    },
    required: ['id'],
  },
  volatile: true,

  preview(args) {
    return `subprocess status: ${args?.id}`;
  },
  async execute(args, ctx) {
    const id = String(args.id ?? '');
    const found = lookupSubprocess(ctx, id);
    if (found.result) return found.result;
    const sub = found.sub;

    if (sub.error) {
      return fail(`Subprocess "${id}" failed to start: ${sub.error}`, {
        code: TOOL_ERROR_CODE.EUNKNOWN,
        data: { id },
      });
    }

    const { stdout, stderr } = readSubprocessOutput(sub);
    if (args.clear) {
      clearSubprocessOutput(sub);
    }

    const output = [stdout && `[stdout]\n${stdout}`, stderr && `[stderr]\n${stderr}`]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_OUTPUT_CHARS);

    const data = {
      id,
      running: !sub.exited,
      pid: sub.process.pid,
      exitCode: sub.exitCode,
      signal: sub.signal,
      stdout,
      stderr,
      // Byte cursor so callers (and guards) can tell new output from a re-read.
      stdoutChars: stdout.length,
      stderrChars: stderr.length,
    };

    // Same crash test as stop_subprocess: an unsignaled nonzero exit means it died on its own, not that anyone stopped it.
    if (isCrashed(sub)) {
      return {
        ok: false,
        kind: 'command',
        code: TOOL_ERROR_CODE.EEXIT,
        error: `Subprocess "${id}" crashed (exit code ${sub.exitCode})`,
        display: `Subprocess "${id}" crashed (exit code ${sub.exitCode})\n${output || '(no output buffered)'}`,
        data,
      };
    }

    return ok({
      kind: 'command',
      display:
        `Subprocess "${id}" ${sub.exited ? `exited (code ${sub.exitCode}${sub.signal ? `, signal ${sub.signal}` : ''})` : `running (pid ${sub.process.pid})`}\n` +
        (output || '(no output buffered)'),
      data,
    });
  },
});
