import { configFile, type McpServerConfig } from '../core/config';
import type { McpServerStatus } from './registry';
import { bold, dim, green, yellow, red, icons } from '../ui/ansi';

function toolPrefix(serverName: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]/, 't$&');
  return `mcp__${clean(serverName)}__`;
}

export function describeMcpServers(
  servers: McpServerConfig[],
  { connected, status }: { connected?: { name: string }[]; status?: McpServerStatus[] } = {},
): string {
  if (servers.length === 0) {
    return `${dim('  no MCP servers configured')}\n  ${dim('add one under "mcpServers" in')} ${dim(configFile())}`;
  }

  const lines: string[] = [];
  for (const server of servers) {
    const state = server.disabled ? yellow('disabled') : green('enabled');
    lines.push(`${icons.bullet} ${bold(server.name)} ${dim(`(${state})`)}`);
    lines.push(`    ${dim('command')}  ${[server.command, ...(server.args ?? [])].join(' ')}`);
    if (server.env) lines.push(`    ${dim('env')}  ${Object.keys(server.env).join(', ')}`);
    if (!connected || server.disabled) continue;

    const tools = connected.filter((tool) => tool.name.startsWith(toolPrefix(server.name)));
    const reached = status?.some((entry) => entry.name === server.name && entry.connected);
    if (tools.length > 0) {
      lines.push(`    ${dim('tools')}   ${tools.map((tool) => tool.name).join(', ')}`);
    } else if (!reached) {
      lines.push(`    ${red(`${icons.fail} did not start — no tools from this server`)}`);
    } else {
      lines.push(`    ${red(`${icons.fail} connected but no tools advertised`)}`);
    }
  }
  return lines.join('\n');
}
