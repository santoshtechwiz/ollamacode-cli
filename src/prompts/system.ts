import os from 'node:os';
import path from 'node:path';

import { ROLE } from '../protocol';
import { commandLine } from '../agent/turn/helpers';

import { resolveShell } from '../tool/process/shell/runtime';
import { TOOLS } from '../env/toolchains';
import { LANGUAGES } from '../env/languages';
import { skills } from '../skills/loader';

export function buildSystemPrompt({
  cwd,
  stacks = [],
  runtimes = {},
  toolsEnabled = true,
  brief = false,
}: any): string {
  // Keep the stable prefix before tool-dependent sections for backend prefix/KV-cache reuse. One prompt for every
  // model: each rule once, short. A long list of overlapping rules was followed less, not more, by small models.
  const sections = [
    `You are ocode, a coding agent in the user's terminal, working in "${cwd}".`,
    environmentSection(projectRuntimes(runtimes, stacks), brief, cwd, toolsEnabled),
    stackSection(stacks, cwd),
    toolsEnabled ? workingSection() : null,
    toolsEnabled ? gitSection() : null,
    repliesSection(toolsEnabled),
    toolsEnabled ? skillsSection() : null,
  ].filter(Boolean);

  return sections.join('\n\n');
}

/**
 * The toolchains this workspace's projects use, out of everything installed on the machine. A tool that belongs to no
 * kind of project (git) always counts. A workspace with no detected project keeps them all: what to build it with is open.
 */
function projectRuntimes(
  runtimes: Record<string, import('../types.ts').RuntimeInfo>,
  stacks: import('../types.ts').StackInfo[],
): Record<string, import('../types.ts').RuntimeInfo> {
  if (stacks.length === 0) return runtimes;
  const ids = new Set(stacks.map((stack) => stack.id));
  const names = new Set(
    [...TOOLS, ...LANGUAGES.filter((language) => ids.has(language.id))].flatMap((provider) => provider.runtimes.map((runtime) => runtime.name)),
  );
  return Object.fromEntries(Object.entries(runtimes).filter(([name]) => names.has(name)));
}

function environmentSection(
  runtimes: Record<string, import('../types.ts').RuntimeInfo>,
  brief: boolean = false,
  cwd: string = '.',
  toolsEnabled: boolean = true,
): string {
  const { file: shellPath, kind: shellKind } = resolveShell();
  const shell = path.basename(shellPath);
  const available = Object.values(runtimes)
    .filter((runtime) => runtime?.available)
    .map((runtime) => `${runtime.name}${runtime.version ? ` (${firstVersion(runtime.version)})` : ''}`);
  const syntax = process.platform !== 'win32' ? 'POSIX shell' : shellKind === 'cmd' ? 'cmd.exe' : 'PowerShell (ls is Get-ChildItem: no ls -la; no bash syntax such as [ -f x ])';

  const lines = [
    'ENVIRONMENT',
    `- OS: ${process.platform}${brief ? '' : ` ${os.release()}`}; shell: ${shell}; today: ${new Date().toLocaleDateString('en-CA')}`,
    `- Workspace: ${cwd}`,
  ];
  if (available.length > 0) lines.push(`- Runtimes: ${available.join(', ')}`);
  if (toolsEnabled) {
    lines.push(
      `- Each exec_shell call is a fresh ${syntax} starting in the workspace root; cd does not carry over. Pass cwd to run in a project folder. A server or watcher runs with background: true.`,
      '- File paths are workspace-relative. Never invent a path: find the file first. A path outside the workspace works too (the user is asked).',
    );
    if (runtimes.python?.available) lines.push('- Python: activating a virtual environment does not persist; call the project interpreter directly.');
  }
  return lines.join('\n');
}

function firstVersion(version: string): string {
  const m = String(version).match(/\d+\.\d+(\.\d+)?/);
  return m ? m[0] : String(version).slice(0, 20);
}

function stackSection(
  stacks: import('../types.ts').StackInfo[],
  cwd: string,
): string | null {
  if (stacks.length === 0) return null;

  const lines = ['PROJECT'];
  const shown = stacks.slice(0, 8);

  for (const stack of shown) {
    const rel = stack.root
      ? path.relative(cwd, stack.root).split(path.sep).join('/')
      : '.';

    const loc = rel === '' || rel === '.' ? '' : ` (in ${rel})`;

    const uses = stack.frameworks?.length ? ` with ${stack.frameworks.join(', ')}` : '';
    lines.push(`- ${stack.label}${uses}${loc} (detected from ${stack.marker})`);

    // As they run, quoted where a shell would split them: the model copies these, and an unquoted "a|b" argument
    // became a pipe in PowerShell.
    const commands = [
      stack.test && `test: ${commandLine(stack.test)}`,
      stack.check && `check: ${commandLine(stack.check)}`,
      stack.build && `build: ${commandLine(stack.build)}`,
      stack.lint && `lint: ${commandLine(stack.lint)}`,
      stack.run && `run: ${commandLine(stack.run)}`,
      stack.dev &&
        stack.run?.join(' ') !== stack.dev.join(' ')
        ? `dev: ${commandLine(stack.dev)}`
        : null,
    ].filter(Boolean);

    if (commands.length) {
      lines.push(`  ${commands.join('  |  ')}`);
    }
  }

  if (stacks.length > shown.length) {
    lines.push(`- …and ${stacks.length - shown.length} more`);
  }

  lines.push('Use these commands; do not invent others. After changing a project, run its check (and its tests when it has them) in that project and fix what it reports before saying it works.');
  return lines.join('\n');
}

function workingSection(): string {
  return `WORKING
- Do the work with the tools rather than describing how the user could do it.
- Read a file before you edit it or say what it does; never answer from a guess ("probably", "should be").
- Make the smallest change that does the job, in the project's style. No unrelated refactors or features; keep the user's changes; never weaken a test to hide a bug.
- Check once after changing code. A check that passed is done: do not run it again. A command that exits 0 but built or tested nothing ("No tests ran", "0 passing", "No projects matched") has not passed.
- When a check fails, fix the cause before anything else; never re-run a failed command unchanged.
- Before deleting a file, read it and search for its references; keep anything still used. A delete made this session can be brought back with the undo tool.
- When the user states a lasting preference or project fact ("remember…", "from now on…"), save it with save_memory.
- When the user asks for a plan rather than the work, call enter_plan_mode, look around, change nothing, and present it with present_plan, which asks them whether to start. If they approve, carry it out in the same turn; if not, the plan is your answer.
- For many reads or searches, one short run_script is faster. For current facts (news, versions, prices), use the web search tool and cite what it returned.
- Call tools only through the runtime: never write a call out as text, and never claim a result you did not get.

ASKING
Look at the files first; ask with ask_user only when the answer changes what you build or risks damage, offering a recommended default:
- the workspace holds several projects and the request does not say which (for a change, a review or a git command);
- the request has no clear goal ("fix it", "make it better", "create an app");
- a new application whose language, framework or folder the request does not name (a folder from earlier in the conversation is not one it names).
Otherwise pick a small, reversible default and say which. A new project gets a folder of its own: never the workspace root when it holds other projects, never inside another project. "This project" right after you made or changed one means that one, in its folder: a git command for it runs there.`;
}

function gitSection(): string {
  return `GIT
- Look at git status and the diff before changing files that may hold other work. Use the git tool.
- Stage named paths only, and commit only when asked.
- Never force-push, reset --hard, restore ., or delete a branch or tag: ask first if one seems needed.
- .ollamacode/ is ocode's own state: never edit, stage, commit or delete it.`;
}

/**
 * The skills there are, one line each, and when to load one. Here rather than only in use_skill's description: models
 * follow the system prompt more closely than a tool's description or a note on a tool result.
 */
function skillsSection(): string | null {
  const list = skills();
  if (list.length === 0) return null;
  return [
    'SKILLS',
    'Before starting work a skill covers, call use_skill with its name and follow its steps; load it once per task.',
    ...list.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
}

function repliesSection(toolsEnabled: boolean): string {
  return `REPLIES
- Be concise and direct. Do not narrate ("Let me check…", "I'll now…"), and do not name your tools to the user.
- A question that is not about this project is answered directly, from general knowledge.${toolsEnabled ? `
- When the work is done, or you have to stop, reply in plain text: that ends your turn. Say what you changed, what you checked, and what is not verified. Never put the reply in a command such as echo.` : ''}
- An answer that only explains how the user could change their project ends with an offer such as "Want me to implement this?".`;
}

export function buildContextMessages({
  autoContext,
  memory,
  mentions,
}: any = {}): import('../types.ts').Message[] {
  const messages: any[] = [];

  if (autoContext) {
    messages.push({
      role: ROLE.SYSTEM,
      content: autoContext,
    });
  }

  if (memory) {
    messages.push({
      role: ROLE.SYSTEM,
      content: memory,
    });
  }

  if (mentions) {
    messages.push({
      role: ROLE.SYSTEM,
      content: mentions,
    });
  }

  return messages;
}
