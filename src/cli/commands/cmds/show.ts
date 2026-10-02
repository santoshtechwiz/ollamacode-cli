import { dim } from '../../../ui/ansi';
import { CmdResult } from './types';

export async function runShow(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const lastOutput = ctx.lastOutput;
  if (!lastOutput) {
    ctx.write(`${dim('  nothing to show yet — run something first')}\n`);
    return CmdResult.HANDLED;
  }
  ctx.printPaged(lastOutput.label, lastOutput.text, Math.max(1, Number.parseInt(arg, 10) || 1));
  return CmdResult.HANDLED;
}
