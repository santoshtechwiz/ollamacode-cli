import { runMcpCommand } from '../../mcp/command';
import { red, icons } from '../../ui/ansi';
import { withProgress } from '../../ui/progress';

export async function run(flags: { check?: boolean; }, positionals: string[] = []) {
  await runMcpCommand(flags, positionals, {
    write: (text) => process.stdout.write(text),
    error: (message) => process.stdout.write(`${red(`${icons.fail} ${message}`)}\n`),
  }, async (promise) => withProgress('connecting MCP servers', () => promise, {
    successText: (tools: any) => `connected ${tools.length} tool${tools.length === 1 ? '' : 's'}`,
  }));
}
