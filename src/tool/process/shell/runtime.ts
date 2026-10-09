import fs from 'node:fs';
import path from 'node:path';

import { TOOL_ERROR_CODE } from '../../../protocol';
import { fail } from '../../core/tool-result';
import { runChild, type ChildOutcome } from '../../../env/process/index';
import { statType } from '../../filesystem/_fs';

interface ShellSpec {
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

/**
 * Windows PowerShell 5.1 has no `&&` or `||` (PowerShell 7 does): every `cd x && npm test` failed there with "the token
 * '&&' is not a valid statement separator". Each chain operator outside quotes becomes its 5.1 meaning — run the rest
 * only if the last command succeeded (`;if ($?) {…}`) or failed (`;if (-not $?) {…}`). Anything else is left as written.
 */
function chainsForPowerShell51(cmd: string): string {
  // Only a single plain statement is rewritten. Several statements (; or a newline), blocks and subexpressions
  // ({ } ( ) $( )), backtick escapes and here-strings change where a chain ends; those are left exactly as written.
  if (/[;\n\r{}()`]|@["']/.test(cmd.replace(/(["'])(?:(?!\1)[^`])*\1/g, ''))) return cmd;
  if (/`/.test(cmd)) return cmd;
  const parts: string[] = [];
  const ops: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = cmd.slice(i, i + 2);
    if (pair === '&&' || pair === '||') {
      parts.push(current.trim());
      ops.push(pair);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  // A mixed chain (a && b || c) groups differently in each shell: left as written rather than risk a wrong meaning.
  if (ops.length === 0 || parts.some((p) => !p) || new Set(ops).size > 1) return cmd;
  if (ops[0] === '&&') {
    // A failure stops the chain with that command's exit code, as && does — not a skipped block that reads as success.
    const stop = '; if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE } else { exit 1 } }; ';
    return parts.join(stop);
  }
  // a || b || c: each next one runs only if everything before it failed.
  let out = parts[parts.length - 1];
  for (let k = parts.length - 2; k >= 0; k--) out = `${parts[k]}; if (-not $?) { ${out} }`;
  return out;
}

export function resolveShell(): ShellSpec {
  if (shellCache) return shellCache;

  if (process.platform === 'win32') {
    const pwsh = which('pwsh') || which('powershell');
    if (pwsh) {
      shellCache = {
        file: pwsh,
        args: (cmd) => ['-NoProfile', '-NonInteractive', '-Command', withExitCode(/pwsh/i.test(pwsh) ? cmd : chainsForPowerShell51(cmd))],
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

interface RunShellOptions {
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

type CallCwd =
  | { cwd: string; result?: undefined }
  | { cwd?: undefined; result: import('../../../types.ts').ToolResult };

/**
 * Which part of a missing directory is missing: " (there is no ollamatetst in c:\projects)". A typo deep in a long
 * path is easy to miss when the whole path is only said not to exist.
 */
async function missingPart(dir: string): Promise<string> {
  let parent = path.resolve(dir);
  let missing = '';
  while (path.dirname(parent) !== parent && !(await statType(parent))) {
    missing = path.basename(parent);
    parent = path.dirname(parent);
  }
  const found = await statType(parent);
  if (!missing) return found && found.type !== 'dir' ? ` (${parent} is a file)` : '';
  return found?.type === 'dir' ? ` (there is no ${missing} in ${parent})` : '';
}

/** Where this one call runs. */
export async function resolveCallCwd(
  args: { cwd?: unknown },
  ctx: { cwd: string; root?: string; state?: any }
): Promise<CallCwd> {
  // With no cwd: the workspace root, where every path the model writes starts, file tools' and commands' alike. Running
  // in the working project instead read `ls ./notes-app` from inside notes-app/, and a scaffolder given the project's
  // name built a second copy inside it: the model writes paths from the root, so the command starts there.
  const cwd = args.cwd ? String(args.cwd) : ctx.root ?? ctx.cwd;
  const found = await statType(cwd);
  if (!found || found.type !== 'dir') {
    if (!args.cwd) {
      return {
        result: fail(`Working directory does not exist: ${cwd}`, {
          code: TOOL_ERROR_CODE.ENOENT,
          hint: 'The working directory was removed. Pass a cwd that exists, or recreate it.',
        }),
      };
    }
    return {
      result: fail(`Working directory does not exist: ${args.cwd}${await missingPart(cwd)}`, {
        code: TOOL_ERROR_CODE.ENOENT,
        hint: 'cwd must name an existing directory, relative to the workspace or absolute. Omit it to run in the workspace root.',
      }),
    };
  }
  return { cwd };
}
