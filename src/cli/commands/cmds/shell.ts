import { dim } from '../../../ui/ansi';
import { CmdResult } from './types';

export async function runShell(ctx: any, arg: string): Promise<boolean | 'exit'> {
  if (!arg) {
    ctx.write(`${dim('  usage: /shell <command> — run a shell command in the current directory (alias !<command>)')}\n`);
    return CmdResult.HANDLED;
  }
  await ctx.runShellCommand(arg);
  return CmdResult.HANDLED;
}
