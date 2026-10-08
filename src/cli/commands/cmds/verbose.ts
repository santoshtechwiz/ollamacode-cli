import { dim, green, yellow } from '../../../ui/ansi';
import { CmdResult } from './types';

export async function runVerbose(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const v = String(arg ?? '').toLowerCase().trim();
  if (v === 'on' || v === 'yes' || v === '1') ctx.expandTools = true;
  else if (v === 'off' || v === 'no' || v === '0') ctx.expandTools = false;
  else ctx.expandTools = !ctx.expandTools;
  ctx.write(
    `  ${ctx.expandTools ? green('tool output expanded') : yellow('tool output collapsed')}${dim(' — for this session (config ui.expandTools to persist)')}\n`
  );
  return CmdResult.HANDLED;
}
