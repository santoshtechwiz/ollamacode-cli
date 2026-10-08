import { dim, green, yellow } from '../../../ui/ansi';
import { loadConfig, updateConfig } from '../../../core/config';
import { setColorMode } from '../../../ui/ansi';
import { CmdResult } from './types';

export async function runColor(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const v = arg.trim().toLowerCase();
  const cur = loadConfig().ui?.color ?? 'auto';
  if (!v) {
    ctx.write(`${dim(`  colour mode: ${cur} — /color auto|on|off`)}\n`);
    return CmdResult.HANDLED;
  }
  if (v === 'auto' || v === 'on' || v === 'off') {
    updateConfig((c) => {
      c.ui = { ...c.ui, color: v };
    });
    setColorMode(v);
    ctx.write(`${green(`  colour → ${v}`)}${dim(' — saved to config.json')}\n`);
    return CmdResult.HANDLED;
  }
  ctx.write(`${yellow('  usage: /color auto|on|off')}\n`);
  return CmdResult.HANDLED;
}
