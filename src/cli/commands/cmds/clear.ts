import { dim, green, icons } from '../../../ui/ansi';
import { CmdResult } from './types';

export async function runClear(ctx: any): Promise<boolean | 'exit'> {
  ctx.startNewSession();
  ctx.write(`  ${green(icons.ok)} new session ${dim('— it replaces the previous conversation')}\n`);
  return CmdResult.HANDLED;
}
