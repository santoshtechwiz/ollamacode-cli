import { CONTINUE_INPUT } from '../../../agent/intent';
import { CmdResult } from './types';

/** Carry on with unfinished work: a stopped turn, a paused plan, a cut-off answer. Chosen, never read from wording. */
export async function runContinue(ctx: any): Promise<boolean | 'exit'> {
  await ctx.runOneTurn(CONTINUE_INPUT, { continuing: true });
  return CmdResult.HANDLED;
}
