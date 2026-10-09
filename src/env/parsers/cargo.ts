import type { Diagnostic } from '../../types';
import { dedupe, scan } from './shared';

// cargo build, check, clippy and test.

export function parseCargo(output: string): Diagnostic[] {
  const out = scan(output, /^(error|warning)(?:\[(E\d+)\])?:\s*(.+)\n\s*-->\s*(.+?):(\d+):(\d+)/gm, (m) => ({
    file: m[4].trim(), line: Number(m[5]), column: Number(m[6]), severity: m[1], code: m[2], message: m[3].trim(),
  }));
  out.push(...scan(output, /^thread '([^']+)'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):?\n(.*)$/gm, (m) => ({
    file: m[2].trim(), line: Number(m[3]), column: Number(m[4]), severity: 'failure', message: `${m[1]}: ${m[5].trim()}`,
  })));
  return dedupe(out);
}
