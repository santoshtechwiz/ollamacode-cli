import { clamp } from '../../core/tool-result';
import { shortenPaths } from '../../../env/diagnostics/paths';
import { renderDiagnostics } from '../../../env/diagnostics/render';
import type { ShellExecutionResult, Diagnostic } from '../types';

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

const MAX_OUTPUT_CHARS = 30_000;

interface FormatOutputInput {
  execution: ShellExecutionResult;
  command: string;
  diagnostics?: Diagnostic[];
}

export function formatOutput(input: FormatOutputInput): { presentation: string; truncated: boolean } {
  const { execution, command, diagnostics = [] } = input;
  
  const stdout = trimStackNoise(execution.stdout.trim());
  const stderr = trimStackNoise(execution.stderr.trim());

  const parts: string[] = [];
  parts.push(`$ ${command}`);
  if (stdout) parts.push(stdout);
  if (stderr) parts.push(`[stderr]\n${stderr}`);

  if (execution.discardedBytes > 0) {
    parts.push(`[output truncated: ${execution.discardedBytes} further bytes discarded]`);
  }

  if (diagnostics.length > 0) {
    const summary = renderDiagnostics(diagnostics);
    if (summary) parts.push(`[diagnostics]\n${summary}`);
  }

  parts.push(execution.exitCode !== null ? `[exit ${execution.exitCode}]` : `[exit null]`);

  const combined = parts.filter(Boolean).join('\n');
  const { text, truncated } = clamp(shortenPaths(combined, ''), MAX_OUTPUT_CHARS);

  return { presentation: text, truncated };
}