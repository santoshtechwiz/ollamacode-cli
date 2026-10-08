import type { ArgsDef } from 'citty';
import { bold, cyan, dim } from '../ui/ansi';

/** Single source of truth for top-level CLI arguments. */
export const CLI_ARGS_DEF = {
  provider: { type: 'string', description: 'force a provider' },
  model: { type: 'string', description: 'pick a model' },
  token: { type: 'string', description: 'provider token (cloud backends)' },
  log: { type: 'string', description: 'log level' },
  timeout: { type: 'string', description: 'request timeout' },
  scope: { type: 'string', description: 'work outside the current directory' },
  root: { type: 'string', description: 'alias for --scope' },
  cwd: { type: 'string', description: 'alias for --scope' },
  ctx: { type: 'string', description: 'context window sent to the backend' },
  'max-tokens': { type: 'string', description: 'cap on each generation' },
  prompt: { type: 'string', description: 'run one task and exit' },
  continue: { type: 'boolean', alias: 'c', description: 'continue the last session' },
  yes: { type: 'boolean', alias: 'y', description: 'auto-approve risky tools' },
  help: { type: 'boolean', alias: 'h', description: 'show help' },
  debug: { type: 'boolean', description: 'full prompt + wire traffic to log file' },
  tools: { type: 'boolean', description: 'disable tool calling with --no-tools' },
  plan: { type: 'boolean', description: 'plan and approve before acting' },
  review: { type: 'boolean', description: 'read and report, never change' },
  fix: { type: 'boolean', description: 'apply safe fixes (doctor)' },
  new: { type: 'boolean', description: 'start fresh without being asked' },
  version: { type: 'boolean', description: 'show version' },
  all: { type: 'boolean', description: 'include all entries' },
  staged: { type: 'boolean', description: 'staged changes only' },
  // Boolean on purpose: args.ts extracts the mode itself, so a bare --think is true and a following non-mode word stays positional.
  think: { type: 'boolean', description: "render the model's reasoning" },
  check: { type: 'boolean', description: 'connect MCP servers to verify them' },
  'expand-tools': { type: 'boolean', description: 'render full tool output' },
  project: { type: 'boolean', description: 'seed project memory (init); --no-project skips it' },
} satisfies ArgsDef;

export const CLI_COMMANDS = Object.freeze([
  'init',
  'doctor',
  'chat',
  'models',
  'config',
  'memory',
  'mcp',
  'reindex',
  'help',
]);

export const CLI_HELP = `
  ${bold('ocode')} — local-first terminal coding agent (Ollama / HuggingFace)

  ${bold('Usage')}
    ${cyan('ocode')}                          start coding — continue the last session or begin a new one
    ${cyan('echo "<task>" | ocode')}          one-shot task through the same chat, saved so you can continue or undo it
    ${cyan('ocode init')}                     detect backends, authenticate, pick a model, seed memory
    ${cyan('ocode doctor [--fix]')}           diagnose config, provider, auth and workspace issues
    ${cyan('ocode reindex [prune|clear|status]')} rebuild or clear the workspace index (.ollamacode/index/workspace.db)
    ${cyan('ocode models')}                   list available models
    ${cyan('ocode memory [show|add|forget]')} inspect what the agent remembers about this project
    ${cyan('ocode mcp [--check]')}            list configured MCP servers (--check connects them)
    ${cyan('ocode config [get|set|unset]')}   inspect or change settings

  ${bold('Sessions')}
    ${dim('Each workspace keeps its last session, so closing the terminal loses nothing —')}
    ${dim('the next launch offers to continue it. Starting a new one replaces it.')}
    ${cyan('-c, --continue')}                 continue the last session, no questions
    ${cyan('--new')}                          start fresh without being asked

  ${bold('Options')}
    ${cyan('--model <name>')}                 pick a model
    ${cyan('--provider <ollama|hf>')}         force a provider
    ${cyan('--plan')}                         plan and approve before acting
    ${cyan('-y, --yes')}                      auto-approve risky tools
    ${cyan('--scope <path>')}                 work outside the current directory
    ${cyan('--no-tools')}                     disable tool calling
    ${cyan('--think <show|hide|detailed>')}   render the model's reasoning
    ${cyan('--ctx <tokens>')}                 context window sent to the backend (default 32768, capped by the model)
    ${cyan('--max-tokens <n>')}               cap on each generation (default 512)
    ${cyan('--debug')}                        summaries on stderr; the full prompt, tool schemas and
                                   wire traffic to ~/.ollamacode/logs

  ${dim('New here? Run "ocode init" — it detects what is available on this machine.')}
`;
