import { NOT_ATTEMPTED_CODES, READ_ONLY_TOOLS, TOOL_RESULT_STATUS } from '../protocol';

import { dim, red, green, yellow, cyan, magenta } from './ansi';
import { colorizeDiffLine } from './diff';
import { langFromPath } from './highlight';
import { fmtPath, fmtCommand, highlightFileLineRefs } from './format';
import { toolLabel, shellLabel } from './render/labels';

const ansi = { red, green, dim, bold: (s: string) => s, cyan };

function categoryColor(name: string): (s: string) => string {
  if (name === 'exec_shell') return yellow;
  if (name === 'git') return magenta;
  if (READ_ONLY_TOOLS.has(name)) return cyan;
  return (s: string) => s;
}

export function toolTally(results: { result: { ok: boolean; code?: string; data?: unknown; }; }[]): { ran: number; ok: number; failed: number; refused: number; fixable: number; skipped: number; } {
  let ok = 0;
  let failed = 0;
  let refused = 0;
  let fixable = 0;
  let skipped = 0;
  for (const { result } of results ?? []) {
    if (result.ok) ok += 1;
    else if (result.code === 'ESKIPPED') skipped += 1;
    // Bad or missing arguments: the model was told what to fix. Nothing refused it, so it is not "not allowed".
    else if (result.code === 'EINVAL') fixable += 1;
    else if (NOT_ATTEMPTED_CODES.includes( (result.code as any))) refused += 1;
    else failed += 1;
  }
  return { ran: ok + failed, ok, failed, refused, fixable, skipped };
}

interface ToolView {
  ok: boolean;
  /** Neither a success nor a failure: a call the harness or the tool skipped, shown without alarm. */
  neutral?: boolean;
  /** Part of the work happened and part did not (status PARTIAL): a warning, not an error. */
  partial?: boolean;
  title: string;
  detail: string[];
  hint?: string;
  hidden?: number;
  bulk?: boolean;
  command?: boolean;
  expand?: boolean;
}

function looksLikeDiff(line: string): boolean {
  return line.trimStart().startsWith('──') || line.startsWith('- ') || line.startsWith('+ ') || /^\s*\d/.test(line);
}

/** A completed (or skipped) line of a todo_write result: `[x] …` or `[-] …`. */
const COMPLETED_LINE = /^\[[xX-]\]/;

function detailPreview(value: string | undefined, maxLines: number = 5, maxCharsPerLine: number = 500): { lines: string[]; hidden: number; } {
  const raw = String(value ?? '');
  if (!raw.trim()) return { lines: [], hidden: 0 };
  const all = raw.split('\n');
  const lines = all.slice(0, maxLines).map((l) => {
    const t = l.trimEnd();
    return t.length > maxCharsPerLine ? `${t.slice(0, maxCharsPerLine - 3)}...` : t;
  });
  return { lines: lines.filter((l, i) => l.trim() || i > 0), hidden: Math.max(0, all.length - maxLines) };
}

function commandSummary(display: string | undefined): string | null {
  const first = String(display ?? '').split('\n')[0] ?? '';
  const m = first.match(/^\$\s*(.+)$/);
  return m ? m[1] : null;
}

function fileSummary(display: string | undefined): string | null {
  const first = String(display ?? '').split('\n')[0] ?? '';
  const m = first.match(/^(Created directory [^\s]+|Created [^\s]+|Overwrote [^\s]+|Edited [^\s]+|Patched [^\s]+|Created [^\s]+\/)/);
  if (!m) return null;
  return m[1].replace(/\s+\(\d+ bytes\)(?:\s*\[verified:[^\]]*\])?/, '').trim() || null;
}

function resultPath(result: import('../types.ts').ToolResult): string | null {
  const data = (result.data ?? {} as Record<string, any>);
  if (data.path) return String(data.path);
  if (data.file) return String(data.file);
  if (data.command) return null; // commands have their own formatting
  return null;
}

function bodyLine(l: string, lang: string = ''): string {
  return looksLikeDiff(l) ? colorizeDiffLine(l, ansi, lang) : cyan(highlightFileLineRefs(l));
}

function describeSuccess(name: string, result: import('../types.ts').ToolResult, shellKind?: string, commandShown?: boolean): ToolView {
  const isFile =
    result.kind === 'file' || name === 'write_file' || name === 'edit_file';
  const isCommand = name === 'exec_shell';
  const pathHint = resultPath(result);
  const mark = result.truncated ? yellow(' [truncated]') : '';

  if (isFile) {
    const verb = fileSummary(result.display);
    const summary = verb ?? toolLabel(name, pathHint ? { path: pathHint } : undefined);
    const body = String(result.display ?? '').split('\n').slice(verb ? 1 : 0);
    const color = verb ? green : categoryColor(name);
    const lang = langFromPath(pathHint);
    return { ok: true, title: `${color(summary)}${mark}`, detail: body.map((l) => bodyLine(l, lang)), expand: Boolean(verb) };
  }

  // The task list is the live progress the person watches through the turn, so every line of it
  // stays on screen: a one-line preview behind "N more lines" is the plan instead of the work.
  // The list itself lives in the live checklist; repeating it under every update printed it twice.
  if (name === 'todo_write') {
    const lines = String(result.display ?? '').split('\n').filter((l) => l.trim());
    const done = lines.filter((l) => COMPLETED_LINE.test(l)).length;
    const count = lines.length ? dim(` — ${done} of ${lines.length} done`) : '';
    return { ok: true, title: `${toolLabel(name)}${count}${mark}`, detail: [] };
  }

  // A server handed to the background is running, not finished; its first line already says where.
  if (isCommand && result.data?.background && result.data?.exitCode === undefined) {
    const [first, ...rest] = String(result.display ?? '').split('\n');
    const { lines, hidden } = detailPreview(rest.join('\n'), 12, 500);
    return { ok: true, title: `${green(first)}${mark}`, detail: lines.map((l) => bodyLine(l)), hidden, command: true };
  }

  if (isCommand) {
    // Command text already shown above, so the line only says how it ended.
    const cmd = commandSummary(result.display);
    const head = commandShown
      ? 'finished'
      : cmd
        ? `${shellLabel(shellKind)}(${fmtCommand(cmd)})`
        : pathHint
          ? fmtPath(pathHint)
          : toolLabel(name);
    const exit = result.data?.exitCode !== undefined ? dim(` exit ${result.data.exitCode}`) : '';
    const { lines, hidden } = detailPreview(String(result.display ?? '').replace(/^\$.*\n?/, ''), 40, 500);
    const detail = lines.map((l) => bodyLine(l));
    if (result.data?.discardedBytes > 0) {
      detail.push(yellow(`[${result.data.discardedBytes} bytes of output not shown]`));
    }
    return { ok: true, title: `${categoryColor(name)(head)}${exit}${mark}`, detail, hidden, command: true };
  }

  const { lines, hidden } = detailPreview(result.display, 40, 500);
  return {
    ok: true,
    title: `${categoryColor(name)(toolLabel(name))}${pathHint ? ` ${fmtPath(pathHint)}` : ''}${mark}`,
    detail: lines.map((l) => bodyLine(l, langFromPath(pathHint))),
    hidden,
  };
}

function describeFailure(name: string, result: import('../types.ts').ToolResult, shellKind?: string, commandShown?: boolean): ToolView {
  const isCommand = name === 'exec_shell';
  const pathHint = resultPath(result);

  // A call the rules did not let run (blocked, skipped, refused by policy) is not a failure: one dim line, no red ERROR.
  if (result.code === 'EBLOCKED' || result.code === 'ESKIPPED' || result.code === 'EPOLICY') {
    // A skipped call always prints one dim line, so it never reads as the session doing nothing.
    const line = String(result.note ?? result.error ?? 'not executed').split('\n')[0];
    return { ok: false, neutral: true, title: dim(line), detail: [] };
  }

  // Work that went part of the way is a warning: what it reached is in the detail, and the model has the rest.
  if (result.status === TOOL_RESULT_STATUS.PARTIAL) {
    const [first, ...rest] = String(result.note ?? result.error ?? 'stopped before finishing').split('\n');
    const { lines } = detailPreview(String(result.display ?? ''), 20, 500);
    return { ok: false, partial: true, title: `${toolLabel(name)}${dim(' — ')}${yellow(first)}`, detail: [...rest, ...lines].map((l) => dim(l)) };
  }

  // A call the model got wrong (bad or missing arguments, an edit that would break the file) never ran: the
  // model is told exactly what to fix. The person sees that it was caught, not the schema text.
  if (result.code === 'EINVAL') {
    const label = toolLabel(name, pathHint ? { path: pathHint } : undefined);
    // One short line of why, in the tool's own words: enough to see what keeps failing without the session file.
    const why = String(result.error ?? '').split('\n')[0]
      .replace(/^Refusing to (?:edit|write) [^:]+:\s*/, '')
      .replace(/\.?\s*Nothing was written\.?$/, '')
      .trim();
    // Argument-format errors are schema text for the model ("Invalid argument(s): x must be one of …"): not shown.
    const reason = /^Invalid argument/i.test(why) ? '' : why.length > 110 ? `${why.slice(0, 109)}…` : why;
    return { ok: false, neutral: true, title: dim(`${label} — not run: the model's request needed fixing, and it was told how`), detail: reason ? [dim(reason)] : [] };
  }

  // A tool's hint is recovery advice for the model, which already has it; the person only sees how to approve a denial.
  const ownHint = typeof result.hint === 'string' && result.hint.trim() ? result.hint : undefined;
  // No stock advice: "--yes" was wrong for a call --yes does not cover, and a person who said no needs none.
  const approvalHint = result.code === 'EDENIED' || result.code === 'ESCAPE' ? ownHint : undefined;

  const diagnostics = (list: Array<{ file?: string; line?: number; message?: string; }>) =>
    list
      .slice(0, 4)
      .map(
        (d) =>
          `${fmtPath(String(d.file ?? ''))}${d.line ? `${dim(':')}${yellow(String(d.line))}` : ''} ${d.message ?? ''}`
      );

  if (isCommand) {
    const exitCode = result.data?.exitCode;
    const cmd = commandSummary(result.display);
    const head = commandShown
      ? red('failed')
      : cmd
        ? `${shellLabel(shellKind)}(${fmtCommand(cmd)}) ${red('failed')}`
        : red(toolLabel(name, undefined, shellKind));
    const exit = exitCode !== undefined ? dim(` (exit ${exitCode})`) : '';

    const detail: any[] = [];
    if (result.data?.diagnostics?.length) {
      for (const d of diagnostics(result.data.diagnostics)) detail.push(magenta(d));
    } else if (result.note ?? result.error) {
      const first = String(result.note ?? result.error).split('\n')[0] ?? 'failed';
      if (!/^Command exited with code/i.test(first)) detail.push(red(first));
    }
    const { lines, hidden } = detailPreview(
      String(result.display ?? '').replace(/\n?\[exit [^\]]*\]\s*$/, ''),
      40,
      500
    );
    for (const l of lines) {
      if (l.startsWith('$ ') || /^\[(stderr|diagnostics|exit|output truncated)/.test(l)) continue;
      detail.push(looksLikeDiff(l) ? colorizeDiffLine(l, ansi) : yellow(l));
    }
    if (result.data?.discardedBytes > 0) {
      detail.push(yellow(`[${result.data.discardedBytes} bytes of output not shown]`));
    }
    return { ok: false, title: `${head}${exit}`, detail, hidden, bulk: true, command: true, hint: approvalHint };
  }

  const errParts = String(result.note ?? result.error ?? 'failed').split('\n');
  const detail = errParts.slice(1).map((l) => red(l));

  if (result.display) {
    const isEditMiss = name === 'edit_file' && (result.code === 'ENOMATCH' || result.code === 'EAMBIGUOUS');
    const { lines } = detailPreview(result.display, isEditMiss ? 40 : 20, 500);
    const lang = langFromPath(pathHint);
    for (const l of lines) detail.push(bodyLine(l, lang));
  }
  if (result.data?.diagnostics?.length) {
    for (const d of diagnostics(result.data.diagnostics)) detail.push(magenta(d));
  }

  // Live lines drop [CODE]; session record keeps it.
  return {
    ok: false,
    title: `${red(`ERROR ${name}`)}${pathHint ? ` ${fmtPath(pathHint)}` : ''}${dim(' — ')}${red(errParts[0])}`,
    detail,
    hint: approvalHint,
  };
}

export function describeToolResult(
  name: string,
  result: import('../types.ts').ToolResult,
  shellKind?: string,
  commandShown?: boolean
): ToolView {
  // A skipped call (ESKIPPED) is neither a success nor an alarm: describeFailure gives it one dim line, and its
  // hint stays with the model.
  // What only the person is shown goes under what both see.
  const shown = result.screen ? { ...result, display: [result.display, result.screen].filter(Boolean).join('\n') } : result;
  return shown.ok ? describeSuccess(name, shown, shellKind, commandShown) : describeFailure(name, shown, shellKind, commandShown);
}

