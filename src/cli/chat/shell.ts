import { dim, green, icons, red } from '../../ui/ansi';
import { resolveShell, runShellDirect } from '../../tool/process/shell/runtime';
import { dangerousReason, refusalReason } from '../../tool/policy/mutation-policy';
import { parseDiagnostics } from '../../env/diagnostics/parse';
import { verifyDiagnostics } from '../../env/diagnostics/verify';
import { formatShellPreview } from '../../ui/format';
import { withProgress } from '../../ui/progress';
import type { Diagnostic } from '../../types';

interface ShellDeps {
  write: (text: string) => void;
  /** Must pause/resume whatever owns the terminal's raw mode around the question — the caller knows that, this module doesn't. */
  confirm: (message: string, defaultYes: boolean) => Promise<boolean>;
  cwd: string;
  /** Lets the caller's cancel key (Ctrl-C/Esc) abort the running command. Runs unabortable when omitted. */
  signal?: AbortSignal;
}

type ShellStatus = 'ok' | 'failed';

interface ShellOutput {
  label: string;
  text: string;
  command: string;
  /** null only when the process never reported one. */
  exitCode: number | null;
  status: ShellStatus;
  durationMs: number;
  diagnostics: Diagnostic[];
}

/** Keeps the transcript one line per result, regardless of what the user typed. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/* eslint-disable no-control-regex */
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const CSI = /\x1b\[([0-9;?]*)([A-Za-z])/g;
const OTHER_ESC = /\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
/* eslint-enable no-control-regex */

/** Strips terminal control sequences from tool output before it reaches the user's terminal. */
function sanitize(text: string): string {
  return text
    .replace(OSC, '')
    .replace(CSI, (whole, _params, final) => (final === 'm' ? whole : ''))
    .replace(OTHER_ESC, '')
    .replace(/^.*\r(?!\n)/gm, '')
    .replace(CONTROL, '');
}

/** Runs one shell command with the refusal/danger gates. */
export async function runShellCommand(deps: ShellDeps, command: string): Promise<ShellOutput | null> {
  const { write, confirm, cwd, signal } = deps;
  const startedAt = Date.now();
  const flat = oneLine(command);

  const record = (
    status: ShellStatus,
    exitCode: number | null,
    text: string,
    diagnostics: Diagnostic[] = [],
  ): ShellOutput => ({
    label: `exec_shell: ${truncate(flat, 72)}`,
    text,
    command,
    exitCode,
    status,
    durationMs: Date.now() - startedAt,
    diagnostics,
  });

  {
    const shell = resolveShell();
    write(`${formatShellPreview({ shell: shell.kind, cwd, command })}\n`);

    // Refusal is a hard no — ask about the danger only if the command is even allowed to run.
    const refused = refusalReason(command);
    if (refused) {
      write(`${red(`${icons.fail} Refused: ${refused}`)}\n`);
      return null;
    }

    const danger = dangerousReason(command);
    if (danger) {
      let ok = false;
      try {
        ok = await confirm(
          `${red(icons.warn)} DANGEROUS COMMAND\n  ${dim(truncate(flat, 100))}\n  ${danger}\n  Run it anyway?`,
          false,
        );
      } catch {
        ok = false;
      }
      if (!ok) {
        write(`${dim('  cancelled — dangerous command not run')}\n`);
        return null;
      }
    }

    const out = await withProgress(`running ${truncate(flat, 60)}`, () =>
      runShellDirect(command, { cwd, signal }),
    );

    // Trailing trim only: leading whitespace is load-bearing for diffs, trees and indented compiler output.
    const stdout = sanitize(out.stdout ?? '').replace(/\s+$/, '');
    const stderr = sanitize(out.stderr ?? '').replace(/\s+$/, '');
    const elapsed = formatDuration(Date.now() - startedAt);

    if (out.cancelled) {
      write(`${red(`${icons.fail} cancelled after ${elapsed}`)}\n`);
      return null;
    }
    if (out.timedOut) {
      write(`${red(`${icons.fail} timed out after ${elapsed}`)}\n`);
      return null;
    }
    if (out.spawnError) {
      const message = (out.spawnError as Error).message;
      write(`${red(`${icons.fail} failed to start shell: ${message}`)}\n`);
      return null;
    }
    if (out.exitCode === null) {
      write(`${red(`${icons.fail} shell exited without reporting an exit code`)}\n`);
      return null;
    }

    const body = [stdout, stderr && `${dim('[stderr]')}\n${stderr}`].filter(Boolean).join('\n');
    if (body) write(`${body}\n`);

    const ok = out.exitCode === 0;
    const exitLine = `${ok ? green(`exit ${out.exitCode}`) : red(`exit ${out.exitCode}`)} ${dim(`in ${elapsed}`)}`;
    write(`${exitLine}\n`);

    const diagnostics = body
      ? await verifyDiagnostics(parseDiagnostics(`${stdout}\n${stderr}`, { command, root: cwd }), { root: cwd })
      : [];

    return record(ok ? 'ok' : 'failed', out.exitCode, body, diagnostics);
  }
}
