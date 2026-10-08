import { clamp } from '../../core/tool-result';
import { shortenPaths } from '../../../env/diagnostics/paths';
import { renderDiagnostics } from '../../../env/diagnostics/render';
import type { ShellExecutionResult, CommandHint, Diagnostic } from '../types';

const INTERNAL_FRAME = /^\s*at\s+.*(?:\(?[^()\n]*node_modules[\\/][^()\n]*\)?|\(node:[^)]*\))\s*$/;

function trimStackNoise(text: string): string {
  const output: string[] = [];
  let internalRun = 0;
  for (const line of String(text ?? '').split('\n')) {
    if (INTERNAL_FRAME.test(line)) {
      internalRun += 1;
      if (internalRun === 1) output.push(line);
      else if (internalRun === 2) output.push('    … (internal stack frames omitted)');
    } else {
      internalRun = 0;
      output.push(line);
    }
  }
  return output.join('\n');
}

const DUPLICATE_SCAN_MIN_CHARS = 2_000;
const DUPLICATE_LINE_MIN_CHARS = 40;

function collapseDuplicateLines(text: string): { text: string; removed: number } {
  const raw = String(text ?? '');
  if (raw.length < DUPLICATE_SCAN_MIN_CHARS) return { text: raw, removed: 0 };
  const seen = new Set<string>();
  const output: string[] = [];
  let removed = 0;
  for (const line of raw.split('\n')) {
    const key = line.trim();
    if (key.length < DUPLICATE_LINE_MIN_CHARS || !seen.has(key)) {
      output.push(line);
      if (key.length >= DUPLICATE_LINE_MIN_CHARS) seen.add(key);
    } else {
      removed += 1;
    }
  }
  return { text: output.join('\n'), removed };
}

const MAX_OUTPUT_CHARS = 30_000;

export interface FormatOutputInput {
  execution: ShellExecutionResult;
  hints: CommandHint[];
  command: string;
  diagnostics?: Diagnostic[];
}

export function formatOutput(input: FormatOutputInput): { presentation: string; truncated: boolean } {
  const { execution, hints, command, diagnostics = [] } = input;
  
  const stdout = trimStackNoise(execution.stdout.trim());
  const stderr = trimStackNoise(execution.stderr.trim());

  const shownOut = collapseDuplicateLines(stdout);
  const shownErr = collapseDuplicateLines(stderr);
  const duplicatesRemoved = shownOut.removed + shownErr.removed;

  const earlyPrimary = diagnostics.length > 0 ? diagnostics.find(d => d.severity === 'error' || d.severity === 'failure') : undefined;
  
  const dropCovered = (text: string): string => {
    if (!earlyPrimary && diagnostics.length === 0) return text;
    const kept = text.split('\n').filter((line) => {
      if (/\berror\b/i.test(line) && /error\s+[A-Za-z]*\d+|\(\d+,\d+\)|:\d+:\d*:/i.test(line)) {
        return false;
      }
      return true;
    });
    return kept.join('\n');
  };

  const shownOutText = diagnostics.length > 0 ? dropCovered(shownOut.text) : shownOut.text;
  const shownErrText = diagnostics.length > 0 ? dropCovered(shownErr.text) : shownErr.text;

  const parts: string[] = [];
  parts.push(`$ ${command}`);
  if (shownOutText) parts.push(shownOutText);
  if (shownErrText) parts.push(`[stderr]\n${shownErrText}`);

  if (duplicatesRemoved > 0) {
    parts.push(`[${duplicatesRemoved} repeated line(s) omitted — this tool prints its findings twice; each one above is shown once]`);
  }

  let coveredRemoved = 0;
  if (diagnostics.length > 0) {
    const before = shownOutText + '\n' + shownErrText;
    const after = dropCovered(before);
    coveredRemoved = before.split('\n').length - after.split('\n').length;
    if (coveredRemoved > 0) {
      parts.push(`[${coveredRemoved} error line(s) listed once under [diagnostics] below]`);
    }
  }

  if (execution.discardedBytes > 0) {
    parts.push(`[output truncated: ${execution.discardedBytes} further bytes discarded]`);
  }

  if (diagnostics.length > 0) {
    const summary = renderDiagnostics(diagnostics);
    if (summary) parts.push(`[diagnostics]\n${summary}`);
  }

  for (const hint of hints) {
    parts.push(`[${hint.kind}]\n${hint.message}`);
  }

  parts.push(execution.exitCode !== null ? `[exit ${execution.exitCode}]` : `[exit null]`);

  const combined = parts.filter(Boolean).join('\n');
  const { text, truncated } = clamp(shortenPaths(combined, ''), MAX_OUTPUT_CHARS);

  return { presentation: text, truncated };
}