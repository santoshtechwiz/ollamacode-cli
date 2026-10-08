import { readFile } from 'node:fs/promises';
import { dim, red } from '../../../ui/ansi';
import { createWorkspace } from '../../../agent/workspace/manager';
import { CmdResult } from './types';

export async function runOpen(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const parts = arg.split(/\s+/).filter(Boolean);
  const p = parts[0];
  const off = Math.max(1, Number.parseInt(parts[1] ?? '', 10) || 1);
  if (!p) {
    ctx.write(`${dim('  usage: /open <path> [offset] — shows full file (also Ctrl+O after read)')}\n`);
    if (ctx.lastReadFile) ctx.write(`${dim(`  last: ${ctx.lastReadFile.path} (${ctx.lastReadFile.lines} lines)`)}` + '\n');
    return CmdResult.HANDLED;
  }
  try {
    const abs = await createWorkspace({ root: ctx.workspace.cwd, granted: ctx.workspace.state.grantedRoots }).resolve(p);
    const content = await readFile(abs, 'utf8');
    ctx.printPaged(p, content, off);
    ctx.lastReadFile = { path: p, lines: content.split('\n').length, fullContent: content };
    ctx.lastOutput = { label: p, text: content };
  } catch (e) {
    ctx.write(`${red(`  cannot open ${p}: ${(e as Error).message}`)}\n`);
  }
  return CmdResult.HANDLED;
}
