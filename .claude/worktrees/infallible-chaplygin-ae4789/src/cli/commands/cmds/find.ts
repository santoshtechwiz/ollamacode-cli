import { dim } from '../../../ui/ansi';
import { fuzzyFind } from '../../../context/mentions';
import { CmdResult } from './types';

export async function runFind(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const hits = await fuzzyFind(ctx.workspace.cwd, arg, 15);
  if (hits.length === 0) {
    ctx.write(`${dim(`  nothing matched "${arg}"`)}\n`);
    return CmdResult.HANDLED;
  }
  const picked = await ctx.select(
    `Matches for "${arg}":`,
    hits.map((h) => ({ label: h, value: h }))
  );
  if (picked) {
    ctx.insertText(`@${picked} `);
  }
  return CmdResult.HANDLED;
}
