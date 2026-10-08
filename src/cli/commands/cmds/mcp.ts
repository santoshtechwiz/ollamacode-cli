import { icons, red } from '../../../ui/ansi';
import { runMcpCommand } from '../../../mcp/command';
import { CmdResult } from './types';

export async function runMcp(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const parts = arg.trim().split(/\s+/);
  await runMcpCommand(
    { check: parts[0]?.toLowerCase() === 'check' },
    parts[0]?.toLowerCase() === 'add' ? ['add', parts.slice(1).join(' ')] : [],
    {
      write: (text) => ctx.write(text),
      error: (message) => ctx.write(`${red(`${icons.fail} ${message}`)}\n`),
    },
  );
  return CmdResult.HANDLED;
}
