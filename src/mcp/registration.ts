import { updateConfig, type McpServerConfig } from '../core/config';

function remoteEndpoint(server: McpServerConfig): string | undefined {
  return server.command === 'npx' && server.args?.[1] === 'mcp-remote' ? server.args?.[2] : undefined;
}

function serverStem(url: URL): string {
  const parts = url.hostname.replace(/^www\./i, '').split('.').filter(Boolean);
  const base = parts.length > 1 && parts[0] === 'mcp' ? parts[1] : parts[0];
  return base?.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'remote';
}

function uniqueName(stem: string, servers: McpServerConfig[]): string {
  const names = new Set(servers.map((server) => server.name));
  if (!names.has(stem)) return stem;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
}

function remoteMcpConfig(rawUrl: string, existing: McpServerConfig[] = []): McpServerConfig {
  let url: URL;
  try {
    url = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('MCP URL must be a valid http:// or https:// URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('MCP URL must use http:// or https:// without embedded credentials');
  }

  const endpoint = url.toString();
  if (existing.some((server) => remoteEndpoint(server) === endpoint)) {
    throw new Error('That MCP URL is already registered');
  }

  return {
    name: uniqueName(serverStem(url), existing),
    command: 'npx',
    args: ['-y', 'mcp-remote', endpoint],
    disabled: false,
  };
}

export function addRemoteMcp(rawUrl: string): McpServerConfig {
  let added!: McpServerConfig;
  updateConfig((config) => {
    added = remoteMcpConfig(rawUrl, config.mcpServers);
    config.mcpServers.push(added);
  });
  return added;
}
