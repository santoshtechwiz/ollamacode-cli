import { defineTool } from '../tool/core/defineTool';
import { killProcessTree } from '../env/process/index';
import { ok, fail } from '../tool/core/tool-result';
import { mcpServersConfig } from '../core/config';
import { logger } from '../core/logger';
import { defaultRegistry } from '../tool/execution/registry';
import { McpClient } from './client';

let connected: McpClient[] = [];
let loading: Promise<import('../types.ts').ToolDef[]> | null = null;

/** What a configured server is doing right now, for anything that must answer "is it there?". */
export interface McpServerStatus {
  name: string;
  /** Present in the config and not switched off. */
  enabled: boolean;
  /** Handshake completed and its tools are on the menu. */
  connected: boolean;
}

/** Every configured server and whether it is actually usable. */
export function mcpServerStatus(): McpServerStatus[] {
  const live = new Set(connected.map((c) => String(c.name)));
  return mcpServersConfig().map((cfg) => ({
    name: String(cfg.name),
    enabled: !cfg.disabled,
    connected: live.has(String(cfg.name)),
  }));
}

function qualify(serverName: string, toolName: string): string {
  const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]/, 't$&');
  return `mcp__${clean(serverName)}__${clean(toolName)}`;
}

function bridgeTool(client: McpClient, tool: import('./client.ts').McpTool): import('../types.ts').ToolDef {
  const name = qualify(client.name, tool.name);
  const schema =
    tool.inputSchema && typeof tool.inputSchema === 'object'
      ? { type: 'object', properties: {}, ...tool.inputSchema }
      : { type: 'object', properties: {} };
  const parameters = prepareMcpSchema(client.name, tool.name, schema);

  return defineTool({
    name,
    label: `${client.name}: ${tool.name}`,
    description: `[MCP:${client.name}] ${tool.description ?? tool.name}`,
    parameters,
    risky: true,
    async execute(args) {
      try {
        const res = await client.callTool(tool.name, args);
        if (res.isError) return fail(res.text || `${name} reported an error`, { code: 'EUNKNOWN' });
        return ok({ kind: 'text', display: res.text, data: { raw: res.text } });
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err), { code: 'EUNKNOWN' });
      }
    },
  });
}

const LOADER_NAME = 'load_mcp_tools';

const DEEPWIKI_REPO_PATTERN = '^[^/\\s]+/[^/\\s]+(?:/[^/\\s]+)?$';

function prepareMcpSchema(serverName: string, toolName: string, schema: any): any {
  if (
    String(serverName).toLowerCase() !== 'deepwiki' ||
    String(toolName).toLowerCase() !== 'ask_wiki_question' ||
    !schema.properties?.repoName ||
    schema.properties.repoName.pattern
  ) {
    return schema;
  }

  return {
    ...schema,
    properties: {
      ...schema.properties,
      repoName: {
        ...schema.properties.repoName,
        pattern: DEEPWIKI_REPO_PATTERN,
        description:
          `${schema.properties.repoName.description ?? 'Repository name'} ` +
          '(use owner/repo, or host/owner/repo for a custom Git host)',
      },
    },
  };
}

function serverOf(def: import('../types.ts').ToolDef): [string, string] {
  const label = String(def.label ?? def.name);
  const at = label.indexOf(': ');
  return at < 0 ? ['mcp', def.name] : [label.slice(0, at), label.slice(at + 2)];
}

function signature(def: import('../types.ts').ToolDef): string {
  const required = def.parameters.required ?? [];
  const params = Object.keys(def.parameters.properties ?? {}).map((k) => `${k}${required.includes(k) ? '' : '?'}`);
  const summary = String(def.description).replace(/^\[MCP:[^\]]*\]\s*/, '').split(/(?<=\.)\s/)[0];
  return `- ${def.name}(${params.join(', ')}) — ${summary}`;
}

// MCP schemas are deferred so they don't ride along on every request; this tool lists them by name and loads them on demand.
export function mcpLoaderTool(defs: import('../types.ts').ToolDef[]): import('../types.ts').ToolDef {
  const byServer = new Map<string, import('../types.ts').ToolDef[]>();
  for (const def of defs) {
    const [server] = serverOf(def);
    byServer.set(server, [...(byServer.get(server) ?? []), def]);
  }
  const catalog = [...byServer].map(([server, list]) => `${server}: ${list.map((d) => serverOf(d)[1]).join(', ')}`).join('\n');

  return defineTool({
    name: LOADER_NAME,
    label: 'Load MCP tools',
    // Compact prompts send only the brief, so it must still say which servers exist or the model believes there are none.
    brief: `Load external MCP tools before calling them. Servers: ${[...byServer.keys()].join(', ')}`.slice(0, 180),
    description:
      'External MCP tools are available but not loaded. Call this with the tools you need, then call them as mcp__<server>__<tool>. ' +
      'Pass exact tool names; a server name loads all of its tools, so prefer specific tools. Available:\n' + catalog,
    parameters: {
      type: 'object',
      properties: {
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool names (e.g. browser_navigate) or a server name' },
      },
      required: ['tools'],
    },
    async execute(args) {
      // Accept "browser_navigate", "playwright", "playwright:browser_navigate" or "mcp__playwright__browser_navigate".
      const asked = (Array.isArray(args.tools) ? args.tools : [args.tools])
        .map((t: unknown) => String(t ?? '').trim().toLowerCase().split(/:|__|\//).filter(Boolean).pop() ?? '')
        .filter(Boolean);
      const picked = defs.filter((def) => {
        const [server, tool] = serverOf(def);
        return asked.some((a: string) => a === def.name || a === tool.toLowerCase() || a === server.toLowerCase());
      });
      if (picked.length === 0) {
        return fail(`No MCP tool matches ${asked.join(', ') || 'the request'}`, {
          code: 'EINVAL',
          hint: `Pick names from:\n${catalog}`,
        });
      }
      defaultRegistry.load(picked.map((d) => d.name));
      return ok({ kind: 'text', display: `Loaded — call these directly now:\n${picked.map(signature).join('\n')}` });
    },
  });
}

export function ensureMcpTools(): Promise<import('../types.ts').ToolDef[]> {
  if (!loading) loading = connectAll();
  return loading;
}

/** Advertise deferred tools for a server explicitly requested by the user. */
export function loadMcpServers(names: readonly string[]): number {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  const tools = defaultRegistry.defs.filter((def) => {
    const [server] = serverOf(def);
    return wanted.has(server.toLowerCase());
  });
  return defaultRegistry.load(tools.map((tool) => tool.name)).length;
}

async function connectAll() {
  const configs = mcpServersConfig().filter((c) => !c.disabled);
  if (configs.length === 0) return [];

  const defs: import('../types.ts').ToolDef[] = [];
  await Promise.all(
    configs.map(async (cfg) => {
      const client = new McpClient(cfg);
      try {
        await client.connect();
        const tools = await client.listTools();
        for (const tool of tools) defs.push(bridgeTool(client, tool));
        connected.push(client);
        logger.debug(`mcp[${cfg.name}] connected, ${tools.length} tool(s)`);
      } catch (err) {
        logger.warn(`mcp[${cfg.name}] failed to connect: ${err instanceof Error ? err.message : err}`);
        await client.close().catch(() => {});
      }
    })
  );
  return defs;
}

export async function closeMcpServers() {
  const toClose = connected;
  connected = [];
  loading = null;
  await Promise.all(toClose.map((c) => c.close().catch(() => {})));
}

process.on('exit', () => {
  for (const client of connected) {
    if (!client.child) continue;
    try {
      killProcessTree(client.child);
    } catch {
    }
  }
});
