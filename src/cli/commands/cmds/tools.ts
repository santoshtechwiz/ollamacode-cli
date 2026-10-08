import { dim, green, yellow } from '../../../ui/ansi';
import { CmdResult } from './types';

export async function runTools(ctx: any): Promise<boolean | 'exit'> {
  ctx.toolsEnabled = !ctx.toolsEnabled;
  ctx.persist();
  ctx.write(`  ${ctx.toolsEnabled ? green('tools ON') : yellow('tools OFF')}${dim(' — remembered for this session')}\n`);
  return CmdResult.HANDLED;
}
