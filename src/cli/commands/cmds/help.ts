import { dim } from '../../../ui/ansi';
import { CmdResult } from './types';

export async function runHelp(ctx: any, arg: string): Promise<boolean | 'exit'> {
  // Dynamic: the table lives in the registry that imports this module.
  const { renderHelp, renderCommandHelp } = await import('../registry.ts');
  const target = arg.trim();
  if (target) {
    const help = renderCommandHelp(target);
    ctx.write(help ? `${help}\n` : `${dim(`  unknown command ${target} — try /help`)}\n`);
    return CmdResult.HANDLED;
  }
  ctx.write(`${renderHelp({ supportsThinking: ctx.workspace.supportsThinking ?? false, footer: ctx.helpFooter })}\n`);
  return CmdResult.HANDLED;
}
