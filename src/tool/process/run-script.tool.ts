import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { defineTool } from '../core/defineTool';
import { ok, fail } from '../core/tool-result';
import { TOOL_ERROR_CODE } from '../../protocol';
import { logger } from '../../core/logger';
import { runChild } from '../../env/process/index';
import { validateShellRequest } from './execution/request';
import { ownProcessStoppedBy, ownProcessRefusal } from './analysis/own-process';
import { formatOutput } from './output/presentation';
import { childEnv, which } from './shell/runtime';

const SCRIPT_LANGUAGES = ['javascript', 'typescript', 'python', 'powershell', 'bash'] as const;
type ScriptLanguage = (typeof SCRIPT_LANGUAGES)[number];

const MAX_SCRIPT_CHARS = 64_000;

const EXTENSION: Record<ScriptLanguage, string> = {
  javascript: 'mjs',
  typescript: 'mts',
  python: 'py',
  powershell: 'ps1',
  bash: 'sh',
};

/** The interpreter and its leading arguments for one language, or null when none is installed. Nothing is ever installed. */
function interpreterFor(language: ScriptLanguage): { file: string; args: string[] } | null {
  switch (language) {
    case 'javascript':
      return { file: process.execPath, args: [] };
    case 'typescript': {
      // tsx ships with ocode, so a TypeScript script needs nothing from the user's project.
      try {
        return { file: process.execPath, args: ['--import', import.meta.resolve('tsx')] };
      } catch {
        return null;
      }
    }
    case 'python': {
      const py = which('python3') ?? which('python') ?? which('py');
      return py ? { file: py, args: [] } : null;
    }
    case 'powershell': {
      const pwsh = which('pwsh') ?? which('powershell');
      return pwsh ? { file: pwsh, args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] } : null;
    }
    case 'bash': {
      const bash = process.platform === 'win32' ? null : which('bash');
      return bash ? { file: bash, args: [] } : null;
    }
  }
}

function languageOf(raw: unknown): ScriptLanguage | null {
  const lang = raw === undefined ? 'javascript' : String(raw);
  return (SCRIPT_LANGUAGES as readonly string[]).includes(lang) ? (lang as ScriptLanguage) : null;
}

export default defineTool({
  name: 'run_script',
  profiles: ['core'],
  category: 'process',
  activity: 'Running a script',
  label: 'Run Script',
  brief:
    'Answer questions that span many files or need computing — counts, grouping, totals, comparisons across files, logs, JSON — in one call with a short script.',
  risky: true,
  description:
    'Run a short, ephemeral script and return its stdout, stderr, exit code, duration and whether it timed out. ' +
    'The script is written to the OS temp directory, never into the project, and is deleted afterwards whatever happens. ' +
    'It runs from the workspace root (or cwd); the env var OCODE_ROOT holds the workspace root. ' +
    'Default language is JavaScript, run by Node as an ES module: import what you need ("import fs from \'node:fs/promises\'") and top-level await works. ' +
    'Also: typescript, python, powershell, bash, when that interpreter is installed. ' +
    'Use it for work that would take many native calls: repository/file discovery with a condition, JSON/config analysis, dependency analysis, duplicate detection, ' +
    'structured search/replace, log analysis, collecting project metadata. Print the findings to stdout. ' +
    'Prefer this over repeated read_file/grep_content calls whenever the answer needs more than a couple of them. ' +
    'For a single read, search or edit use read_file, grep_content, find_files or edit_file instead; for project commands (build, test) use exec_shell.',
  parameters: {
    type: 'object',
    properties: {
      code: { type: 'string', bulkArg: true, description: 'The full script source' },
      language: {
        type: 'string',
        enum: [...SCRIPT_LANGUAGES],
        description: 'Script language (default "javascript")',
      },
      args: { type: 'array', items: { type: 'string' }, description: 'Arguments passed to the script (process.argv.slice(2) in JavaScript)' },
      cwd: { type: 'string', pathArg: true, description: 'Run in this directory (workspace-relative); default the workspace root' },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default 120000)' },
    },
    required: ['code'],
  },
  volatile: true,
  preview(args) {
    const lang = languageOf(args?.language) ?? String(args?.language ?? 'javascript');
    const first = String(args?.code ?? '').split('\n').find((l) => l.trim()) ?? '';
    return `run ${lang} script: ${first.trim().slice(0, 120)}`;
  },
  async execute(args, ctx) {
    const code = String(args.code ?? '');
    if (!code.trim()) return fail('Empty script', { code: TOOL_ERROR_CODE.EINVAL });
    if (code.length > MAX_SCRIPT_CHARS) {
      return fail(`Script too long (${code.length} chars, max ${MAX_SCRIPT_CHARS})`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: 'Keep run_script to a short focused script; read data from files instead of inlining it.',
      });
    }
    const language = languageOf(args.language);
    if (!language) {
      return fail(`Unsupported language: ${args.language}`, {
        code: TOOL_ERROR_CODE.EINVAL,
        hint: `One of: ${SCRIPT_LANGUAGES.join(', ')}`,
      });
    }
    const scriptArgs = Array.isArray(args.args) ? args.args.map(String) : [];

    // Same cwd and timeout rules as exec_shell; the command text is only a label here.
    const validation = await validateShellRequest(
      { cwd: args.cwd, timeout_ms: args.timeout_ms, command: `run_script ${language}` },
      { cwd: ctx.cwd, root: ctx.root, state: ctx.state as any, signal: ctx.signal },
    );
    if ('error' in validation) return validation.error;
    const request = validation.request;

    // A script can stop a program by name as well as a command can (os.system, child_process, Stop-Process).
    const own = await ownProcessStoppedBy(code);
    if (own) return ownProcessRefusal(own);

    const interpreter = interpreterFor(language);
    if (!interpreter) {
      return fail(`No ${language} interpreter is installed on this machine`, {
        code: TOOL_ERROR_CODE.ENOENT,
        hint: 'Write the script in JavaScript instead — Node is always available.',
      });
    }

    const label = `run_script (${language})`;
    let dir: string | null = null;
    let scriptPath = '';
    try {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocode-script-'));
      scriptPath = path.join(dir, `script.${EXTENSION[language]}`);
      await fs.writeFile(scriptPath, code, 'utf8');
      logger.debug(`run_script: ${language} in ${request.cwd} (timeout=${request.timeoutMs}ms)`);

      const startedAt = Date.now();
      const outcome = await runChild({
        file: interpreter.file,
        args: [...interpreter.args, scriptPath, ...scriptArgs],
        options: { cwd: request.cwd, env: { ...childEnv(), OCODE_ROOT: ctx.root ?? ctx.cwd } },
        timeoutMs: request.timeoutMs,
        signal: ctx.signal,
      });
      const durationMs = Date.now() - startedAt;

      const data = {
        language,
        cwd: request.cwd,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        exitCode: outcome.exitCode,
        durationMs,
        timedOut: outcome.timedOut,
        cancelled: outcome.cancelled,
        scriptPath,
      };

      if (outcome.spawnError) {
        return fail(`Failed to start ${language} interpreter: ${outcome.spawnError.message}`, {
          code: TOOL_ERROR_CODE.EUNKNOWN,
          data,
        });
      }
      if (outcome.cancelled) return fail('Script cancelled', { code: TOOL_ERROR_CODE.ECANCELLED, data });

      const { presentation, truncated } = formatOutput({
        execution: { ...outcome, durationMs },
        hints: [],
        command: label,
      });

      if (outcome.timedOut) {
        return fail(`Script timed out after ${request.timeoutMs}ms`, {
          code: TOOL_ERROR_CODE.ETIMEDOUT,
          display: presentation,
          hint: 'Narrow what the script scans, or pass a larger timeout_ms.',
          data,
        });
      }
      if (outcome.exitCode !== 0) {
        return {
          ok: false,
          kind: 'command',
          display: presentation,
          truncated,
          error: `Script exited with code ${outcome.exitCode}`,
          hint: 'Read the stderr above, fix the script, and run it again.',
          code: TOOL_ERROR_CODE.EEXIT,
          data,
        };
      }
      return ok({ kind: 'command', display: presentation, truncated, data });
    } finally {
      if (dir) await fs.rm(dir, { recursive: true, force: true }).catch((err) => logger.debug(`run_script cleanup failed: ${err}`));
    }
  },
});
