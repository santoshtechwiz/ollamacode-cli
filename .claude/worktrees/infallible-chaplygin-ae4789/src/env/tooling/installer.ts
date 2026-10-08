import { runChild } from '../process/index';
import { resolveShell, childEnv } from '../../tool/process/shell/runtime';

const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;

export interface InstallOutcome {
  ok: boolean;
  code?: string;
  error?: string;
  exitCode?: number;
  command?: string;
  stdout?: string;
  stderr?: string;
}

export async function installToolchain({ strategy, spec, cwd, signal, timeoutMs = DEFAULT_INSTALL_TIMEOUT_MS }: {
  strategy: import('../../types.ts').InstallStrategy;
  spec: import('../../types.ts').InstallSpec;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<InstallOutcome> {
  let command: string;
  try {
    command = strategy.render(spec, process.platform).command;
  } catch (err) {
    return { ok: false, code: 'EINVAL', error: (err as Error).message };
  }

  const { file, args: shellArgs, verbatim } = resolveShell();
  const out = await runChildImpl({
    file,
    args: shellArgs(command),
    options: {
      cwd,
      env: childEnv(),
      windowsVerbatimArguments: verbatim,
    },
    timeoutMs,
    signal,
  });

  const base = { command };
  if (out.spawnError) {
    return {
      ...base,
      ok: false,
      code: 'EUNKNOWN',
      error: `Failed to start the installer: ${ (out.spawnError as Error).message}`,
    };
  }
  if (out.cancelled) {
    return { ...base, ok: false, code: 'ECANCELLED', error: 'Installation was cancelled' };
  }
  if (out.timedOut) {
    return {
      ...base,
      ok: false,
      code: 'ETIMEDOUT',
      error: `Installation did not finish within ${timeoutMs}ms; the install may be partially applied — verify before continuing`,
    };
  }
  if (out.exitCode === null) {
    return { ...base, ok: false, code: 'EEXIT', error: 'Installer exited without reporting an exit code' };
  }
  return {
    ...base,
    ok: out.exitCode === 0,
    code: out.exitCode === 0 ? undefined : 'EEXIT',
    exitCode: out.exitCode,
    stdout: out.stdout,
    stderr: out.stderr,
  };
}

const runChildImpl = runChild;
