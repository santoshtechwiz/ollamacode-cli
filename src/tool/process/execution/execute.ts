import { runChild, isSandboxSupported, planSandboxedSpawn, type SandboxMode } from '../../../env/process/index';
import { resolveShell, childEnv } from '../shell/runtime';
import type { ShellRequest, ShellExecutionResult } from '../types';

export async function executeShell(request: ShellRequest): Promise<ShellExecutionResult> {
  const { file, args: shellArgs, verbatim } = resolveShell();
  const startTime = Date.now();

  const sandboxMode: SandboxMode | null =
    request.sandboxMode === 'read-only' || request.sandboxMode === 'workspace-write'
      ? request.sandboxMode
      : null;

  if (sandboxMode && !isSandboxSupported()) {
    throw new Error('Sandboxed execution is not supported on this machine');
  }

  const sandboxWorkspace = request.cwd;
  const sandboxPlan = sandboxMode
    ? planSandboxedSpawn(file, shellArgs(request.command), { mode: sandboxMode, workspace: sandboxWorkspace })
    : null;

  const stop = new AbortController();
  const onAbort = () => stop.abort();
  request.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const outcome = await runChild({
      file: sandboxPlan?.file ?? file,
      args: sandboxPlan?.args ?? shellArgs(request.command),
      options: {
        cwd: request.cwd,
        env: request.env ?? childEnv(),
        windowsVerbatimArguments: sandboxPlan ? undefined : verbatim,
      },
      timeoutMs: request.timeoutMs,
      signal: stop.signal,
    });

    const { exitCode, signal, stdout, stderr, spawnError, timedOut, cancelled, discardedBytes } = outcome;

    return {
      exitCode,
      signal,
      stdout,
      stderr,
      spawnError,
      timedOut,
      cancelled,
      discardedBytes,
      durationMs: Date.now() - startTime,
    };
  } finally {
    request.signal?.removeEventListener('abort', onAbort);
    sandboxPlan?.cleanup();
  }
}