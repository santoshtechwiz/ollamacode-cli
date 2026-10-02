import { CmdCategory, CmdResult, type CommandEntry } from './cmds/types';
import { DETAILS, getCommand as findCommand, renderHelp as renderHelpFor, renderCommandHelp as renderCommandHelpFor } from './help';
import { runHelp } from './cmds/help';
import { runExit } from './cmds/exit';
import { runClear } from './cmds/clear';
import { runStatus } from './cmds/status';
import { runProvider } from './cmds/provider';
import { runModel } from './cmds/model';
import { runTools } from './cmds/tools';
import { runPlan } from './cmds/plan';
import { runReview } from './cmds/review';
import { runAsk } from './cmds/ask';
import { runPlans } from './cmds/plans';
import { runContinue } from './cmds/continue';
import { runPermissions } from './cmds/permissions';
import { runThink } from './cmds/think';
import { runVerbose } from './cmds/verbose';
import { runFind } from './cmds/find';
import { runInit } from './cmds/init';
import { runOpen } from './cmds/open';
import { runContext } from './cmds/context';
import { runUsage } from './cmds/usage';
import { runReindex } from './cmds/reindex';
import { runShell } from './cmds/shell';
import { runDebug } from './cmds/debug';
import { runShow } from './cmds/show';
import { runCopy } from './cmds/copy';
import { runEditor } from './cmds/editor';
import { runMemory } from './cmds/memory';
import { runMcp } from './cmds/mcp';
import { runColor } from './cmds/color';
import { runUndo } from './cmds/undo';

export { CmdResult, type CommandEntry, COMMANDS };

const COMMANDS: CommandEntry[] = [
  {
    name: '/help',
    aliases: [],
    category: CmdCategory.CORE,
    description: 'show help (a command name shows details)',
    arg: '[command]',
    usage: '/help [command]',
    details: DETAILS.help,
    run: runHelp,
  },
  {
    name: '/exit',
    aliases: ['/quit'],
    category: CmdCategory.CORE,
    description: 'save and quit',
    usage: '/exit',
    details: DETAILS.exit,
    run: runExit,
  },
  {
    name: '/clear',
    aliases: ['/new'],
    category: CmdCategory.CORE,
    description: 'start a new session (replaces the current one)',
    usage: '/clear',
    details: DETAILS.clear,
    run: runClear,
  },
  {
    name: '/status',
    aliases: [],
    category: CmdCategory.CORE,
    description: 'session, model and settings at a glance',
    usage: '/status',
    details: DETAILS.status,
    run: runStatus,
  },
  {
    name: '/provider',
    aliases: [],
    category: CmdCategory.AGENT,
    description: 'switch provider (the conversation carries over)',
    arg: '[cloud|local]',
    usage: '/provider [cloud|local]',
    details: DETAILS.provider,
    run: runProvider,
  },
  {
    name: '/model',
    aliases: [],
    category: CmdCategory.AGENT,
    description: 'switch model',
    arg: '[name]',
    usage: '/model [name]',
    details: DETAILS.model,
    run: runModel,
  },
  {
    name: '/tools',
    aliases: [],
    category: CmdCategory.AGENT,
    description: 'toggle tool calling on/off',
    usage: '/tools',
    details: DETAILS.tools,
    run: runTools,
  },
  {
    name: '/plan',
    aliases: [],
    category: CmdCategory.AGENT,
    description: 'enter plan mode (propose-and-approve); auto-switches to agent on approval',
    usage: '/plan [on|off|replan|pause]',
    details: DETAILS.plan,
    run: runPlan,
  },
  {
    name: '/review',
    aliases: [],
    category: CmdCategory.AGENT,
    description: 'enter review mode - read and report, never change (explicit, not in Shift+Tab)',
    usage: '/review [on|off]',
    details: DETAILS.review,
    run: runReview,
  },
  {
    name: '/ask',
    aliases: [],
    category: CmdCategory.AGENT,
    description: 'explain and answer, change nothing (Shift+Tab or /ask)',
    usage: '/ask [on|off]',
    details: DETAILS.ask,
    run: runAsk,
  },
  {
    name: '/continue',
    aliases: [],
    category: CmdCategory.AGENT,
    description: 'carry on with unfinished work: a stopped turn or a paused plan',
    usage: '/continue',
    details: DETAILS.continue,
    run: runContinue,
  },
  {
    name: '/plans',
    aliases: [],
    category: CmdCategory.AGENT,
    description: 'list recent plans with status and progress',
    usage: '/plans [n]',
    details: DETAILS.plans,
    run: runPlans,
  },
  {
    name: '/permissions',
    aliases: ['/perms'],
    category: CmdCategory.AGENT,
    description: 'set risky-tool policy (ask/always/never)',
    usage: '/permissions',
    details: DETAILS.permissions,
    run: runPermissions,
  },
  {
    name: '/think',
    aliases: [],
    category: CmdCategory.AGENT,
    description: 'cycle reasoning: hide → ticker → detailed',
    arg: '[hide|show|detailed]',
    hidden: true,
    more: true,
    needsThinking: true,
    usage: '/think [hide|show|detailed]',
    details: DETAILS.think,
    run: runThink,
  },
  {
    name: '/verbose',
    aliases: ['/expand'],
    category: CmdCategory.AGENT,
    description: 'toggle full tool output (default: collapsed)',
    arg: '[on|off]',
    hidden: true,
    more: true,
    usage: '/verbose [on|off]',
    details: DETAILS.verbose,
    run: runVerbose,
  },
  {
    name: '/find',
    aliases: ['/f'],
    category: CmdCategory.WORKSPACE,
    description: 'fuzzy file finder (alias /f)',
    arg: '<text>',
    usage: '/find <text>',
    details: DETAILS.find,
    run: runFind,
  },
  {
    name: '/init',
    aliases: [],
    category: CmdCategory.WORKSPACE,
    description: 'write/update OLLAMACODE.md by exploring the project',
    usage: '/init',
    details: DETAILS.init,
    run: runInit,
  },
  {
    name: '/open',
    aliases: [],
    category: CmdCategory.WORKSPACE,
    description: 'show a file in pages (also Ctrl+O after a read)',
    arg: '<path> [offset]',
    hidden: true,
    more: true,
    usage: '/open <path> [offset]',
    details: DETAILS.open,
    run: runOpen,
  },
  {
    name: '/context',
    aliases: [],
    category: CmdCategory.WORKSPACE,
    description: 'show context usage',
    usage: '/context',
    details: DETAILS.context,
    run: runContext,
  },
  {
    name: '/usage',
    aliases: ['/tokens'],
    category: CmdCategory.WORKSPACE,
    description: 'tokens sent and received this session',
    usage: '/usage',
    details: DETAILS.usage,
    run: runUsage,
  },
  {
    name: '/reindex',
    aliases: [],
    category: CmdCategory.WORKSPACE,
    description: 'rebuild or clear the workspace index (.agent/workspace.db)',
    arg: '[prune|clear|status]',
    usage: '/reindex [prune|clear|status]',
    details: DETAILS.reindex,
    run: runReindex,
  },
  {
    name: '/undo',
    aliases: [],
    category: CmdCategory.WORKSPACE,
    description: 'restore a file the agent changed this session (or remove a file it created)',
    arg: '[path]',
    usage: '/undo [path]',
    details: DETAILS.undo,
    run: runUndo,
  },
  {
    name: '/shell',
    aliases: [],
    category: CmdCategory.TOOLS,
    description: 'run a shell command in the current directory (alias !<command>)',
    arg: '<command>',
    usage: '/shell <command>',
    details: DETAILS.shell,
    run: runShell,
  },
  {
    name: '/debug',
    aliases: [],
    category: CmdCategory.TOOLS,
    description: 'diagnose the last failed command: exit code, errors, failing file',
    arg: '[file]',
    usage: '/debug [file]',
    details: DETAILS.debug,
    run: runDebug,
  },
  {
    name: '/show',
    aliases: [],
    category: CmdCategory.TOOLS,
    description: 'print the last tool output in full (also Ctrl+T)',
    arg: '[offset]',
    usage: '/show [offset]',
    details: DETAILS.show,
    run: runShow,
  },
  {
    name: '/copy',
    aliases: [],
    category: CmdCategory.ADVANCED,
    description: 'copy the last output, a code block (/copy 2), or a file',
    arg: '[n|path]',
    hidden: true,
    usage: '/copy [n|path]',
    details: DETAILS.copy,
    run: runCopy,
  },
  {
    name: '/editor',
    aliases: ['/edit'],
    category: CmdCategory.CORE,
    description: 'compose a long message in $EDITOR (Ctrl+J also adds a line)',
    arg: '[text]',
    usage: '/editor [text]',
    details: DETAILS.editor,
    run: runEditor,
  },
  {
    name: '/memory',
    aliases: [],
    category: CmdCategory.ADVANCED,
    description: 'facts & session state the agent tracked itself (OLLAMACODE.md is the project doc — /init writes that)',
    arg: '[list|add|forget]',
    hidden: true,
    usage: '/memory [list|add <text>|forget <n>]',
    details: DETAILS.memory,
    run: runMemory,
  },
  {
    name: '/mcp',
    aliases: [],
    category: CmdCategory.ADVANCED,
    description: 'show configured MCP servers (name, command, state)',
    arg: '[check]',
    hidden: true,
    more: true,
    usage: '/mcp [check]',
    details: DETAILS.mcp,
    run: runMcp,
  },
  {
    name: '/color',
    aliases: [],
    category: CmdCategory.SETTINGS,
    description: 'set terminal colour mode',
    arg: '[auto|on|off]',
    hidden: true,
    usage: '/color [auto|on|off]',
    details: DETAILS.color,
    run: runColor,
  },
];

export function getCommand(name: string): CommandEntry | undefined {
  return findCommand(COMMANDS, name);
}

export function renderHelp({ supportsThinking = true, footer }: { supportsThinking?: boolean; footer?: string[]; } = {}) {
  return renderHelpFor(COMMANDS, { supportsThinking, footer });
}

export function renderCommandHelp(name: string): string | undefined {
  return renderCommandHelpFor(COMMANDS, name);
}
