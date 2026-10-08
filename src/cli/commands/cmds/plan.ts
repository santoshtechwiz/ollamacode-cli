import { CmdResult } from './types';
import { setMode, withoutMode } from '../../chat/mode';

/** /plan enters Plan mode, /plan off leaves it. */
export async function runPlan(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const sub = String(arg ?? '').trim().toLowerCase();
  setMode(ctx, sub === 'off' ? withoutMode(ctx, 'plan') : 'plan');
  ctx.persist();
  return CmdResult.HANDLED;
}
