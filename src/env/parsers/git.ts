import type { Diagnostic } from '../../types';
import { dedupe, scan } from './shared';

// Merge conflicts in git output.

export function parseGitConflicts(output: string): Diagnostic[] {
  const out = scan(output, /CONFLICT\s*\([^)]*\):\s*(.*)/g, (m) => {
    const rest = String(m[1] ?? '').trim();
    const file = /^Merge\s+conflict\s+in\s+([\w./-]+)/i.exec(rest)?.[1] ?? /^([\w./-]+)/.exec(rest)?.[1] ?? '(merge)';
    return { file, severity: 'error', message: rest || 'merge conflict' };
  });
  if (/Automatic merge failed/i.test(output) && out.length === 0) {
    out.push({ file: '(merge)', severity: 'error', message: 'automatic merge failed; fix conflicts and commit' });
  }
  return dedupe(out);
}
