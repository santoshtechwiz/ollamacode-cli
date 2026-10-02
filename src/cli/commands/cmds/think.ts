import { cyan, dim, green, yellow } from '../../../ui/ansi';
import { setThinkingPreference } from '../../../agent/workspace/thinking';
import { THINKING_MODE } from '../../../protocol';
import { CmdResult } from './types';

export async function runThink(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const v = arg.toLowerCase().trim();
  const wantsOff = v === 'hide' || v === 'off' || v === '0';
  // hide is always accepted: a model that thinks inline without declaring it still costs the tokens.
  if (!ctx.workspace.supportsThinking && !wantsOff) {
    ctx.write(`${dim('  /think is unavailable — this model does not expose reasoning')}\n`);
    return CmdResult.HANDLED;
  }
  if (wantsOff) ctx.showReasoning = false;
  else if (v === 'detailed' || v === 'verbose' || v === 'full') ctx.showReasoning = 'detailed';
  else if (v === 'show' || v === 'on' || v === '1') ctx.showReasoning = true;
  else {
    if (!ctx.showReasoning) ctx.showReasoning = true;
    else if (ctx.showReasoning === true) ctx.showReasoning = 'detailed';
    else ctx.showReasoning = false;
  }

  // The half that was missing: until now this only changed what was drawn, while the model went on spending its whole reply budget reasoning.
  setThinkingPreference(
    ctx.workspace,
    ctx.showReasoning === 'detailed'
      ? THINKING_MODE.DETAILED
      : ctx.showReasoning
        ? THINKING_MODE.SHOW
        : THINKING_MODE.HIDE
  );

  const label =
    ctx.showReasoning === 'detailed' ? cyan('thinking detailed') : ctx.showReasoning ? green('thinking shown') : yellow('thinking hidden');
  const sent = ctx.workspace.thinkingEnabled
    ? 'the model is asked to reason'
    : 'the model is not asked to reason';
  ctx.write(`  ${label}${dim(` — ${sent}, for this session (use /think hide|show|detailed)`)}\n`);
  return CmdResult.HANDLED;
}
