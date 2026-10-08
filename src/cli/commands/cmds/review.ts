import { CmdResult } from './types';
import { setMode, withoutMode } from '../../chat/mode';

/** Review mode, said out loud instead of inferred. */
export async function runReview(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const sub = String(arg ?? '').trim().toLowerCase();
  if (sub === 'off') {
    setMode(ctx, withoutMode(ctx, 'review'));
    ctx.persist?.();
    return CmdResult.HANDLED;
  }
  if (sub === 'on' || sub === '') {
    // Bare /review explicitly enters Review mode (not part of Shift+Tab cycle)
    setMode(ctx, 'review');
    ctx.persist?.();
    return CmdResult.HANDLED;
  }
  // Toggle for any other arg (backward compat for bare toggle expectation)
  setMode(ctx, ctx.reviewMode ? withoutMode(ctx, 'review') : 'review');
  ctx.persist?.();
  return CmdResult.HANDLED;
}