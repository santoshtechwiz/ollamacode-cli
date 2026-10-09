import type { Diagnostic } from '../../types';
import { dedupe, scan } from './shared';

// go build, vet and test.

export function parseGo(output: string): Diagnostic[] {
  const out = scan(output, /^(?:\.\/)?([\w./\\-]+\.go):(\d+):(?:(\d+):)?\s+(.+)$/gm, (m) => ({
    file: m[1], line: Number(m[2]), column: m[3] ? Number(m[3]) : undefined, severity: 'error', message: m[4].trim(),
  }));
  out.push(...scan(output, /^\s*--- FAIL: (\S+)/gm, (m) => ({ file: '(test)', severity: 'failure', message: `${m[1]} failed` })));
  return dedupe(out);
}
