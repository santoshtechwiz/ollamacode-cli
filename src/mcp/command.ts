import { mcpServersConfig } from '../core/config';
import { ensureMcpTools, closeMcpServers, mcpServerStatus } from './registry';
import { addRemoteMcp } from './registration';
import { describeMcpServers } from './describe';

interface McpCommandOutput {
  write(text: string): void;
  error(text: string): void;
}

export async function runMcpCommand(
  flags: { check?: boolean },
  positionals: string[],
  output: McpCommandOutput,
  onProgress?: (promise: Promise<{ name: string }[]>) => Promise<{ name: string }[]>,
): Promise<void> {
  if (positionals[0]?.toLowerCase() === 'add') {
    try {
      const added = addRemoteMcp(positionals[1] ?? '');
      output.write(`added MCP ${added.name}\n`);
    } catch (err) {
      output.error((err as Error).message);
    }
    return;
  }

  const servers = mcpServersConfig();
  let connected;
  let status;
  if (flags.check) {
    try {
      const connect = ensureMcpTools();
      connected = onProgress ? await onProgress(connect) : await connect;
      status = mcpServerStatus();
    } catch (err) {
      output.error((err as Error).message);
      return;
    } finally {
      await closeMcpServers().catch(() => {});
    }
  }
  output.write(`${describeMcpServers(servers, { connected, status })}\n`);
}
