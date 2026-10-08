import { TOOL_ERROR_CODE } from '../../../protocol';
import { fail } from '../../core/tool-result';
import type { ShellRequest } from '../types';
import { resolveCallCwd } from '../shell/runtime';
import { loadConfig } from '../../../core/config';

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 5_000;
const MAX_COMMAND_LENGTH = 8000;

export async function validateShellRequest(
  args: Record<string, unknown>,
  ctx: { cwd: string; root?: string; state?: unknown; signal?: AbortSignal; canAsk?: boolean }
): Promise<{ request: ShellRequest } | { error: ReturnType<typeof fail> }> {
  const command = String(args.command ?? '').trim();
  
  if (!command) {
    return { error: fail('Empty command', { code: TOOL_ERROR_CODE.EINVAL }) };
  }
  
  if (command.length > MAX_COMMAND_LENGTH) {
    return { error: fail('Command too long', { code: TOOL_ERROR_CODE.EINVAL }) };
  }

  const where = await resolveCallCwd(args, ctx);
  if (where.result) {
    return { error: where.result };
  }

  const cwd = where.cwd;
  // A time limit the model set is kept. Without one, a chat asks the person every two minutes whether to keep waiting,
  // and that answer decides: a limit of its own here killed an npm install at the moment the person was asked.
  const asked = Number(args.timeout_ms) > 0;
  const timeoutMs = asked
    ? Math.max(Number(args.timeout_ms), MIN_TIMEOUT_MS)
    : ctx.canAsk ? 0 : DEFAULT_TIMEOUT_MS;

  // The person sets the sandbox in config (permissions.shellSandbox); a model does not get to choose its own.
  const sandboxMode = loadConfig().permissions?.shellSandbox ?? 'none';
  const env = args.env as NodeJS.ProcessEnv | undefined;

  return {
    request: {
      command,
      cwd,
      timeoutMs,
      signal: ctx.signal,
      sandboxMode: sandboxMode === 'none' ? undefined : sandboxMode,
      env,
    },
  };
}