import { bold, cyan, dim } from '../../ui/ansi';
import { INPUT_FOOTER, SHORTCUT_FOOTER } from './text';
import type { CommandEntry } from './cmds/types';

const CATEGORY_LABELS: Record<string, string> = {
  core: 'Core',
  'agent': 'Model & Agent',
  workspace: 'Workspace',
  tools: 'Tools',
  settings: 'Settings',
  advanced: 'Advanced',
};

const CATEGORY_ORDER = [
  'core',
  'agent',
  'workspace',
  'tools',
  'settings',
  'advanced',
];

export const DETAILS = {
  help: 'Without an argument, prints the compact command overview grouped by category. With a command name (e.g. /help model), prints that command’s usage and aliases.',
  exit: 'Saves the session (history, working directory, tool state) and exits. Also reachable with /quit, Ctrl-D, or Ctrl-C twice at the prompt. Only the last session of a workspace is kept: `ocode -c` continues it, and plain `ocode` offers to.',
  clear: 'Starts a new, empty conversation. The one you were in is kept: /sessions lists it and goes back to it (the newest 10 are kept). Alias: /new.',
  status: 'One screen of what this session actually is: new or continued and its size, provider/model and what the model can do, workspace and current directory, and the settings that change behaviour (tools, mode, permissions, tool output, reasoning). The launch banner deliberately shows almost none of this — it prints only what differs from a default session — so this is where the full picture lives.',
  verbose: 'Toggles whether tool results render in full or as a headline plus one line. Collapsed is the default because a twenty-line diff under every write makes a long turn unreadable. Set `ui.expandTools` in config.json to persist it. Alias: /expand.',
  provider: 'Lists every provider and switches to the chosen one; one that is not ready says why, and choosing Hugging Face without a token asks for it. `/provider hf` (or any provider name) switches directly. The conversation, a pending plan and approval state carry over. `/provider cloud` prefers Ollama Cloud and switches to it now; `/provider local` prefers the local daemon. Either also sets the default backend preference (cloud-first / local-first); cloud-only and local-only locks live in config.json as providerMode.',
  model: 'Switches the model. With no argument, shows a picker; with a name, switches directly (unknown names print the available list). Capabilities are re-probed so the new model runs with its own context window and tool mode.',
  tools: 'Toggles tool calling on and off for the session. A model without tools stops being able to read files or run commands.',
  review: 'Read and report, change nothing. `/review` enters Review mode (explicit, not part of Shift+Tab); `/review off` leaves it; `/review on` is an alias for entering. While it is on, every create, edit and delete is refused outright rather than prompted, so a reflexive yes cannot change anything. After a review, use Ask to discuss, or `/review off` (or Shift+Tab) to switch to Agent and apply changes. Session-scoped and cleared when the session ends.',
  plan: 'With no argument, enters Plan mode for this session: the model first looks at the code with read-only tools, then presents a plan and waits for your approval before changing anything (use `/plan off` or Shift+Tab to leave). Off by default, and not remembered across sessions — set `planMode` in config for that, or pass `--plan` per run. Approve, revise or reject the plan at the prompt; approving switches to Agent and runs it. `/plan replan` flags the workspace’s active plan so the next /continue proposes a fresh plan for whatever got stuck. `/plan close` ends the open plan now and removes it. A plan lives only in the session that made it: when its work is done it ends with a summary of what it did and what it left, and nothing carries into the next session.',
  ask: 'Explain and answer, change nothing. `/ask` enters Ask mode (read-only, like Review but for questions). Available also via Shift+Tab cycle Agent → Plan → Ask → Agent. While Ask is on, edits are refused — switch to Agent with Shift+Tab or `/ask off` to make changes. Session-scoped; `/ask off` leaves it.',
  continue: 'Carries on with unfinished work in this session: a turn that stopped before it finished, a paused plan, or an answer cut off by the output limit. Typing the word "continue" is an ordinary message; /continue is what resumes.',
  plans: 'Shows this session’s open plan and how far it got. Finished and closed plans are removed, so there is nothing older to list.',
  permissions: 'Sets the risky-tool policy: ask (prompt each time), always (auto-allow, like --yes) or never (auto-deny). Saved to config.json.',
  find: 'Fuzzy file search over the workspace. Picking a match attaches it to your message as an @mention. Alias: /f.',
  init: 'Inspects the project’s toolchains and writes or updates OLLAMACODE.md with the detected stack, commands and conventions. Re-runs only when the project actually changes.',
  sessions: 'Lists this folder’s saved conversations, newest first, each named by its first question; the newest 10 are kept. `/sessions 3` carries the third one on in this window: the current one is saved first and stays in the list. A resumed conversation starts with default permissions.',
  compact: 'Trims the conversation now: your latest request and its work stay, older tool output is cleared and the oldest messages are removed, leaving a note of how many. The context also trims itself when it fills; this does it sooner. `/compact summary` first asks the model for a short summary of what is removed and keeps it for the model; worth it with a capable model. /clear starts over instead.',
  context: 'Shows how much of the context budget is in use (tokens across messages), plus provider-reported prompt/completion token totals for the session.',
  usage: 'Shows tokens sent to and received from models this session — every call, including planning and summaries — split by model when more than one was used, with the heaviest turns. The footer shows the same as sent/received: this turn while it runs, the session at the prompt. Counts marked ~ were estimated because the backend reported none. Totals carry over when a session is resumed and reset on /clear.',
  reindex: 'Rebuilds the workspace index (.ollamacode/index/workspace.db) from scratch. Normally the index opens by reusing its stored rows and settling them in the background — this is the way to force a full delete-and-rescan, e.g. after a bulk import, a checkout the file watchers never saw. Sub-commands: /reindex (full rebuild), /reindex prune|vacuum (dedupe case-variant workspaces, delete orphaned rows, VACUUM), /reindex clear (delete the db entirely), /reindex status (show size and orphan counts). Also available as `ocode reindex` from the shell.',

  undo: 'Restores the bytes a file had before this session changed it, or removes a file this session created. The file tools (write/edit/json/delete) copy a file’s previous contents before each call, and `/undo` puts the newest recorded change back — pass a path to undo only the most recent change to that file. Commands, multi-file patches and directory changes have no pre-image and cannot be undone.',
  shell: 'Runs a shell command from the workspace root and prints its full output, exit code and parsed diagnostics. The `!` shortcut is an alias. To run elsewhere, chain it in one line: cd sub && <command>.',
  debug: 'Diagnoses the last failed command: exit code, parsed compiler/test errors and the failing file. Pass a path to open that file instead.',
  show: 'Prints the last tool output (or the last answer) into the scrollback, starting at an optional 1-based line offset. Ctrl+T shows the same output as a reveal above the prompt that a second Ctrl+T (or Esc) closes again.',
  memory: 'Inspects what the agent tracked about the project and session. Mostly automatic — memory is injected into every future session here. OLLAMACODE.md is the project doc (/init writes that).',
  mcp: 'Lists configured MCP servers with their command and connection state. `check` actually connects each server to verify it works.',
  color: 'Sets the terminal colour mode: auto (platform heuristic), on or off. Saved to config.json as ui.color.',
  open: 'Shows a file’s contents in pages. Ctrl+O reveals the last file the agent read without typing a path, as a reveal above the prompt that a second Ctrl+O (or Esc) closes again.',
  copy: 'Copies the last tool output or answer to the clipboard. `/copy 2` copies the 2nd fenced code block of it; `/copy <path>` copies a file. Falls back to OSC 52 over SSH when no clipboard binary (clip/pbcopy/wl-copy) exists. The Ctrl+T / Ctrl+O shortcuts cover the common cases.',
  editor: 'Opens $VISUAL (or $EDITOR, else vi/notepad) on a temp file so a long, multi-line message can be composed comfortably. Saving and quitting queues the text as the next message; quitting with an empty file cancels. Aliases: /edit. The quick alternative at the prompt is Ctrl+J for a newline, Enter to send. (Alt+Enter also works where the terminal passes it through — Windows Terminal reserves it for fullscreen, so Ctrl+J is the primary binding.)',
  think: 'Cycles how the model’s reasoning is shown: hidden, a short ticker (“thought for 12s · 40 lines”), or `detailed` (the full transcription, streaming). The ticker is the default so a long deliberation reads as one line, not a wall. `detailed` persists via config thinking=detailed.',
};

// Pure over the passed table, so this module never imports the registry back.
export function getCommand(commands: CommandEntry[], name: string): CommandEntry | undefined {
  const key = String(name ?? '').replace(/^\//, '').toLowerCase();
  return commands.find((c) => {
    if (c.name.slice(1) === key) return true;
    return c.aliases.some((a) => a.slice(1) === key);
  });
}

export function renderHelp(commands: CommandEntry[], { supportsThinking = true, footer }: { supportsThinking?: boolean; footer?: string[]; } = {}) {
  const lines: string[] = [];
  for (const cat of CATEGORY_ORDER) {
    const cmds = commands.filter(
      (c) =>
        c.category === cat && !c.hidden && (!c.needsThinking || supportsThinking)
    );
    if (cmds.length === 0) continue;
    if (lines.length > 0) lines.push('');
    lines.push(`  ${bold(CATEGORY_LABELS[cat])}`);
    for (const c of cmds) {
      lines.push(`  ${cyan(`${c.name}${c.arg ? ` ${c.arg}` : ''}`.padEnd(18))} ${dim(c.description)}`);
    }
  }
  const more = commands.filter(
    (c) => c.hidden && c.more && (!c.needsThinking || supportsThinking)
  );
  if (more.length > 0) {
    lines.push('', `  ${dim(`more: ${more.map((c) => c.name).join(' · ')} — /help <command> for details`)}`);
  }
  lines.push('');
  for (const f of footer ?? [...INPUT_FOOTER, '', ...SHORTCUT_FOOTER]) lines.push(f);
  return lines.join('\n');
}

export function renderCommandHelp(commands: CommandEntry[], name: string): string | undefined {
  const cmd = getCommand(commands, name);
  if (!cmd) return undefined;
  const lines = [`  ${bold(cmd.usage)}`, `  ${dim(cmd.description)}`];
  if (cmd.details) lines.push('', cmd.details);
  if (cmd.aliases.length > 0) lines.push('', `${dim('  aliases: ')}${cmd.aliases.join(', ')}`);
  lines.push(`${dim(`  category: ${CATEGORY_LABELS[cmd.category]}`)}`);
  return lines.join('\n');
}
