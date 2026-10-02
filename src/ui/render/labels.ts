const MAX_GIST = 48;

const TOOL_LABELS = {
  read_file: 'Read',
  write_file: 'Write',
  edit_file: 'Edit',
  delete_file: 'Delete',
  list_directory: 'List',
  create_directory: 'Mkdir',
  find_files: 'Glob',
  grep_content: 'Grep',
  web_fetch: 'Fetch',
  web_search: 'Search',
  read_document: 'Read',
  write_document: 'Write',
  ask_user: 'Ask',
  todo_write: 'Todo',
  save_memory: 'Memory',
  start_subprocess: 'Start',
  stop_subprocess: 'Stop',
  subprocess_status: 'Status',
  ensure_toolchain: 'Toolchain',
  load_mcp_tools: 'Load MCP tools',
};

export function shellLabel(shellKind?: string): string {
  switch (String(shellKind ?? '')) {
    case 'pwsh':
    case 'powershell':
      return 'PowerShell';
    case 'cmd':
      return 'cmd';
    case 'posix':
      return 'bash';
    default:
      return 'Shell';
  }
}

function gistOf(name: string, args: Record<string, unknown>): string {
  const a = args ?? {};
  const raw =
    name === 'git'
      ? [a.operation, a.name ?? a.ref ?? a.paths].filter(Boolean).join(' ')
      : (a.command ?? a.path ?? a.pattern ?? a.query ?? a.file ?? a.url ?? a.id ?? '');
  const gist = String(raw).replace(/\s+/g, ' ').trim();
  return gist.length > MAX_GIST ? `${gist.slice(0, MAX_GIST - 1)}…` : gist;
}

export function toolLabel(name: string, args?: Record<string, unknown>, shellKind?: string): string {
  const tool = String(name ?? '');
  const label =
    tool === 'exec_shell'
      ? shellLabel(shellKind)
      : ((TOOL_LABELS as Record<string, string>)[tool] ?? mcpLabel(tool) ?? titleCase(tool));

  const gist = gistOf(tool, args ?? {});
  return gist ? `${label}(${gist})` : label;
}

function mcpLabel(tool: string): string | null {
  if (!tool.startsWith('mcp__')) return null;
  const parts = tool.slice('mcp__'.length).split('__');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [server, toolName] = parts.map(titleCase);
  return server.toLowerCase() === toolName.toLowerCase() ? toolName : `${server}: ${toolName}`;
}

function titleCase(name: string): string {
  return String(name)
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

