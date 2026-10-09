import type { Diagnostic } from '../../types';
import { dedupe, quotedName, scan } from './shared';

// pytest and Python tracebacks.

const PY_MISSING = /^(NameError|ModuleNotFoundError|ImportError)\b/;

export function parsePytest(output: string): Diagnostic[] {
  const out = scan(output, /^(.*?\.py):(\d+):\s+(.+)$/gm, (m) => {
    const diag: any = { file: m[1].trim(), line: Number(m[2]), severity: 'failure', message: m[3].trim() };
    if (PY_MISSING.test(diag.message)) {
      diag.kind = 'missing';
      diag.symbol = /name '(\w+)' is not defined/i.exec(diag.message)?.[1] ?? quotedName(diag.message) ?? '';
    }
    return diag;
  });
  out.push(...scan(output, /^FAILED\s+(.+?)::(\S+)(?:\s+-\s+(.*))?$/gm, (m) => ({
    file: m[1].trim(), severity: 'failure', message: `${m[2]}${m[3] ? `: ${m[3].trim()}` : ' failed'}`,
  })));
  out.push(...scan(output, /File "([^"]+)", line (\d+)/g, (m) => ({ file: m[1], line: Number(m[2]), severity: 'error', message: 'syntax or import error' })));
  return dedupe(out);
}
