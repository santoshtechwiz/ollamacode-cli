function summarizeArgValue(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((v) => summarizeArgValue(v)).filter(Boolean).join(' ');
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .slice(0, 4)
      .map(([key, val]) => `${key}=${summarizeArgValue(val)}`)
      .filter(Boolean);
    return entries.join(' ');
  }
  return String(value ?? '');
}

/** A human/machine-readable one-line description of one tool call, used by the approval prompts and the execution ledger. */
export function describeCall(def: Pick<import('../../types.ts').ToolDef, 'name'> & Partial<Pick<import('../../types.ts').ToolDef, 'preview'>>, args: Record<string, unknown>) {
  const preview = def.preview;
  if (typeof preview === 'function') {
    try {
      const rendered = String(preview(args));
      if (rendered && rendered !== '[object Object]') return rendered.trim();
    } catch {
    }
  }

  const name = String(def.name ?? 'tool');
  const target = (() => {
    const path = typeof args?.path === 'string' ? args.path : typeof args?.file === 'string' ? args.file : undefined;
    if (path) return ` ${path}`;
    if (name.startsWith('mcp__')) return ` external MCP tool`;
    const command = typeof args?.command === 'string' ? args.command.trim() : undefined;
    if (command) return `: ${command.slice(0, 80)}`;
    const op = typeof args?.operation === 'string' ? args.operation.trim() : undefined;
    if (op) return ` ${op}`;
    const values = Object.entries(args ?? {})
      .slice(0, 2)
      .map(([key, value]) => `${key}=${summarizeArgValue(value)}`)
      .filter(Boolean)
      .join(' ');
    return values ? ` ${values}` : '';
  })();

  const label: Record<string, string> = {
    write_file: 'write file',
    edit_file: 'edit file',
    delete_file: 'delete file',
    exec_shell: 'run command',
    run_script: 'run script',
    git: 'run git',
    stop_process: 'stop process',
    stop_subprocess: 'stop subprocess',
    save_memory: 'save memory',
    undo: 'undo file change',
  };

  const action = label[name] ?? name.replace(/_/g, ' ');
  return `${action}${target}`;
}