import type { Diagnostic } from '../../types';
import { dedupe } from './shared';

// terraform validate and plan.

export function parseTerraform(output: string): Diagnostic[] {
  const out: any[] = [];
  const blocks = [...output.matchAll(/(Error|Warning):\s*([^\n]+)/g)];
  for (let i = 0; i < blocks.length; i++) {
    const seg = output.slice(blocks[i].index, blocks[i + 1]?.index);
    const loc = /on\s+([^\s]+\.tf)\s+line\s+(\d+)(?:, in\s+([^\n:│]+))?/.exec(seg);
    if (!loc) continue;
    out.push({ file: loc[1], line: Number(loc[2]), severity: blocks[i][1].toLowerCase(), message: `${blocks[i][2].trim()}${loc[3] ? ` (${loc[3].trim()})` : ''}` });
  }
  return dedupe(out);
}
