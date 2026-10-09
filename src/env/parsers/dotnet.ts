import type { Diagnostic } from '../../types';
import { dedupe, scan, tagMissingByCode } from './shared';

// dotnet build and dotnet test.

const DOTNET_MISSING = new Set(['CS0246', 'CS0103', 'CS0234']);

export function parseDotnet(output: string): Diagnostic[] {
  const out = scan(output, /^\s*(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s*(.+?)(?:\s+\[([^\]]*)\])?$/gm, (m) => {
    const diag = { file: m[1].trim(), line: Number(m[2]), column: Number(m[3]), severity: m[4], code: m[5], message: m[6].trim(), project: m[7]?.trim() || undefined };
    tagMissingByCode(diag, DOTNET_MISSING);
    return diag;
  });
  out.push(...scan(output, /^\s*(?:Failed|X)\s+(\S+)(?:\s+\[.*\])?$/gm, (m) => ({ file: '(test)', severity: 'failure', message: `${m[1]} failed` })));
  return dedupe(out);
}
