function unicodeAllowed() {
  if (process.env.OCODE_ASCII === '1') return false;
  if (process.env.OCODE_UNICODE === '1') return true;
  if (process.platform !== 'win32') return true;
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.WSL_DISTRO_NAME);
}

const UNICODE = {
  thinking: '✻',
  tool: '●',
  file: '◆',
  dir: '▸',
  command: '❯',
  search: '⌕',
  remote: '⇅',
  success: '✔',
  done: '☺',
  error: '✖',
  warning: '⚠',
  info: 'ℹ',
  complete: '◼',
  pending: '◌',
  branch: '↳',
  collapsed: '▸',
  expanded: '▾',
  bullet: '•',
  plan: '✎',
  todo: '☐',
  user: '›',
  gutter: '│',
  rule: '─',
};

const ASCII = {
  thinking: '*',
  tool: 'o',
  file: '#',
  dir: '>',
  command: '$',
  search: '?',
  remote: '~',
  success: 'v',
  done: ':)',
  error: 'x',
  warning: '!',
  info: 'i',
  complete: '#',
  pending: '.',
  branch: '->',
  collapsed: '>',
  expanded: 'v',
  bullet: '-',
  plan: 'P',
  todo: '[ ]',
  user: '>',
  gutter: '|',
  rule: '-',
};

export const icons = (unicodeAllowed() ? UNICODE : ASCII as any);

export const SPINNER_FRAMES = unicodeAllowed()
  ? ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
  : ['-', '\\', '|', '/'];

/** The box glyph for one task-list line, kept here so the ASCII fallback covers the checklist too. */
export function todoBox(status: 'completed' | 'in_progress' | 'pending'): string {
  if (status === 'completed') return unicodeAllowed() ? '☑' : '[x]';
  if (status === 'in_progress') return unicodeAllowed() ? '▣' : '[~]';
  return unicodeAllowed() ? '☐' : '[ ]';
}

export function toolIcon(name: string): string {
  const n = String(name ?? '');
  if (n === 'todo_write') return icons.todo;
  if (n === 'exec_shell' || n === 'run_script' || n === 'bash' || n === 'shell') return icons.command;
  if (n === 'grep_content' || n === 'find_files' || n === 'glob') return icons.search;
  if (n === 'list_directory' || n === 'create_directory') return icons.dir;
  if (n.startsWith('git')) return icons.remote;
  if (n.startsWith('web') || n.startsWith('fetch') || n.includes('__')) return icons.remote;
  if (n.includes('file') || n === 'read' || n === 'write' || n === 'edit') return icons.file;
  return icons.tool;
}

