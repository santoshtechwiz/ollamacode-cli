import { CmdResult } from './types';
import { setMode, withoutMode } from '../../chat/mode';

/** Ask mode — answer questions, explain code, no edits. */
export async function runAsk(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const sub = String(arg ?? '').trim().toLowerCase();
  if (sub === 'off') {
    setMode(ctx, withoutMode(ctx, 'ask'));
    ctx.persist?.();
    return CmdResult.HANDLED;
  }
  if (sub === 'on' || sub === '') {
    setMode(ctx, 'ask');
    ctx.persist?.();
    return CmdResult.HANDLED;
  }
  setMode(ctx, ctx.askMode ? withoutMode(ctx, 'ask') : 'ask');
  ctx.persist?.();
  return CmdResult.HANDLED;
}
