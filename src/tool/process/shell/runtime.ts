import fs from 'node:fs';
import path from 'node:path';

import { TOOL_ERROR_CODE } from '../../../protocol';
import { fail } from '../../core/tool-result';
import { runChild, type ChildOutcome } from '../../../env/process/index';
import { statType } from '../../filesystem/_fs';

export interface ShellSpec {
  file: string;
  args: (cmd: string) => string[];
  verbatim: boolean;
  kind: 'pwsh' | 'powershell' | 'cmd' | 'posix';
}

/** PATH lookup honouring PATHEXT. */
export function which(name: string): string | null {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
      }
    }
  }
  return null;
}

let shellCache: ShellSpec | null = null;

/**
 * The command as a PowerShell script that exits with the code of what it ran. `powershell -Command` exits 1 for any
 * failure, so a program's own code (a test runner's 2, docker's 125, a job's 3) never reached ocode or the model.
 * Success and failure stay exactly as PowerShell decides them (`$?`); a failed program's own code is passed through,
 * and a failed cmdlet, which has none, still exits 1. Lines, not `;`, so a trailing `# comment` cannot swallow it.
 */
export function withExitCode(cmd: string): string {
  return ['$global:LASTEXITCODE = 0', cmd, 'if ($?) { exit 0 }', 'if ($LASTEXITCODE) { exit $LASTEXITCODE }', 'exit 1'].join('\n');
}

export function resolveShell(): ShellSpec {
  if (shellCache) return shellCache;

  if (process.platform === 'win32') {
    const pwsh = which('pwsh') || which('powershell');
    if (pwsh) {
      shellCache = {
        file: pwsh,
        args: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', withExitCode(cmd)],
        verbatim: false,
        kind: /pwsh/i.test(pwsh) ? 'pwsh' : 'powershell',
      };
      return shellCache;
    }
    const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
    shellCache = {
      file: comspec,
      args: (cmd) => ['/d', '/s', '/c', `"${cmd}"`],
      verbatim: true,
      kind: 'cmd',
    };
    return shellCache;
  }

  const shell = process.env.SHELL || '/bin/sh';
  shellCache = { file: shell, args: (cmd) => ['-c', cmd], verbatim: false, kind: 'posix' };
  return shellCache;
}

/** The environment every child gets: no agent credentials, no colour, CI set. */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['HF_TOKEN', 'OLLAMACODE_HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) {
    delete env[key];
  }
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.CI = env.CI ?? '1';
  return env;
}

export interface RunShellOptions {
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export function runShellDirect(command: string, { cwd, signal, timeoutMs }: RunShellOptions = {}): Promise<ChildOutcome> {
  const { file, args: shellArgs, verbatim } = resolveShell();
  return runChild({
    file,
    args: shellArgs(command),
    options: { cwd, env: childEnv(), windowsVerbatimArguments: verbatim },
    timeoutMs,
    signal,
  });
}

export type CallCwd =
  | { cwd: string; result?: undefined }
  | { cwd?: undefined; result: import('../../../types.ts').ToolResult };

/** Where this one call runs. */
export async function resolveCallCwd(
  args: { cwd?: unknown },
  ctx: { cwd: string; root?: string; state?: { activeProject?: { root: string } | null } }
): Promise<CallCwd> {
  // When args.cwd is omitted, resolve in order: workspace root → active project root → context cwd.
  const activeRoot = ctx.state?.activeProject?.root;
  const cwd = args.cwd ? String(args.cwd) : ctx.root ?? activeRoot ?? ctx.cwd;
  const found = await statType(cwd);
  if (!found || found.type !== 'dir') {
    const base = args.cwd ? ` (workspace-relative)` : '';
    return {
      result: fail(`Working directory does not exist: ${args.cwd ?? cwd}${base}`, {
        code: TOOL_ERROR_CODE.ENOENT,
        hint: args.cwd
          ? 'The cwd argument is workspace-relative and must name an existing directory. Omit it to run from the workspace root.'
          : 'The working directory was removed. Pass a cwd that exists, or recreate it.',
      }),
    };
  }
  return { cwd };
}
