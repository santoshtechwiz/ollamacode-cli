import { parseDiagnostics } from '../../../env/diagnostics/parse';
import type { Diagnostic } from '../types';

export async function parseShellDiagnostics(
  stdout: string,
  stderr: string,
  options: { command: string; root?: string; cwd?: string }
): Promise<Diagnostic[]> {
  const combined = `${stdout}\n${stderr}`;
  const envDiagnostics = await parseDiagnostics(combined, {
    command: options.command,
    root: options.root,
  });

  return envDiagnostics.map((d) => ({
    file: d.file ?? '',
    line: d.line,
    column: d.column,
    severity: d.severity === 'error' ? 'error' : 'warning',
    message: d.message ?? '',
    code: d.code,
    project: d.project,
    kind: d.kind,
    symbol: d.symbol,
  }));
}