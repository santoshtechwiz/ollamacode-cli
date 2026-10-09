import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { THINKING_MODE, type ThinkingMode } from '../protocol';
import type { ProviderMode } from '../model/providers/mode';

interface TcConfig {
  activeProvider: string | null;
  /** Ollama backend preference; explicit provider choices always win over it. */
  providerMode: ProviderMode;
  models: Record<string, string>;
  tokens: Record<string, string>;
  permissions: {
    risky: 'ask' | 'always' | 'never';
    /** Windows only: run every exec_shell command under a restricted token. Your choice, never the model's. */
    shellSandbox?: 'none' | 'read-only' | 'workspace-write';
  };
  toolsEnabled: boolean;
  planMode: boolean;
  agent: AgentConfig;
  mcpServers: McpServerConfig[];
  routing: RoutingConfig;
  ui: { color: 'auto' | 'on' | 'off'; expandTools?: boolean; };
}

interface RoutingConfig {
  enabled: boolean;
  speed: boolean;
  allowRemote: boolean;
  maxModelBytes: number | null;
}

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  disabled?: boolean;
}

interface AgentConfig {
  maxIterations: number;
  idleTimeoutMs: number;
  firstTokenTimeoutMs: number;
  toolTimeoutMs?: number;
  maxToolOutput: number;
  maxIterationOutput: number;
  /** History target in tokens; unset, it is sized from the model's window each request. */
  contextBudget?: number;
  maxRetries: number;
  /** Unset: the model's own default. */
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  keepAlive?: string;
  /** The user's preference. `auto` asks the workspace to decide — see resolveThinking(). */
  thinking?: ThinkingMode;
  /** The resolved answer to "does the model actually think", threaded onto the config object per turn by turn.ts. */
  thinkingEnabled?: boolean;
  /** Whether the session's model declares a thinking channel. */
  supportsThinking?: boolean;
  /** This model writes reasoning into the answer unless given a channel. */
  reasoningLeaks?: boolean;
  /** Measured generation rate, for sizing what one reply may cost. */
  tokensPerSec?: number;
  memory?: { enabled: boolean; maxChars?: number; };
  /** Let the agent hand self-contained tasks to subagents (delegate_task). On unless set to false. */
  subagents?: boolean;
  /** A command run after any step that changed files (tests, a linter), check words ("check lint"), or "auto". Unset: none. */
  afterEdit?: string;
  /** Like afterEdit, run when the model answers after changing files; a failure goes back to the model. "auto" picks the checks. */
  beforeDone?: string;
  /** How long an afterEdit or beforeDone check may run before it is stopped, ms. Unset: 90 s after an edit, 5 min before done. */
  checkTimeoutMs?: number;
  /** Subagent roles of the person's own, by name; see agent/subagent/roles.ts. */
  subagentRoles?: Record<string, import('../agent/subagent/roles.ts').CustomRoleConfig>;
}

export const DEFAULTS = Object.freeze({
  activeProvider: null,
  providerMode: ('cloud-first' as ProviderMode),
  models: {},
  tokens: {},
  permissions: { risky: ('ask' as 'ask'), shellSandbox: ('none' as 'none') },
  toolsEnabled: true,
  planMode: false,
  mcpServers: [],
  routing: {
    enabled: true,
    speed: false,
    allowRemote: false,
    maxModelBytes: (null as number | null),
  },
  ui: { color: ('auto' as 'auto'), expandTools: false },
  agent: {
    maxIterations: 100,
    idleTimeoutMs: 120_000,
    firstTokenTimeoutMs: 300_000,
    toolTimeoutMs: 600_000,
    maxToolOutput: 8000,
  maxIterationOutput: 40_000,
    // A hosted model's 5xx often lasts a few seconds: five tries back off over ~6s instead of giving up after ~1.5s.
    maxRetries: 4,
    // No temperature: each model samples at its own default (gpt-oss ships 1.0); a low fixed value made reasoning
    // models repeat themselves. agent.temperature still sets one.
    // The window the backend is driven at; resolveSessionBudget() clamps it to what the model declares.
    contextWindow: 32_768,
    maxTokens: 512,
    keepAlive: '30m',
    // `auto`: think where the model supports it and the backend can afford it.
    thinking: (THINKING_MODE.AUTO as ThinkingMode),
    memory: { enabled: true, maxChars: undefined },
    subagents: true,
    // Before the agent says it is done with changed files, ocode checks the work itself (see agent/turn/check-plan.ts):
    // a model's "the site is ready" was too often unchecked. "off" turns it off; a verb list or a command replaces it.
    beforeDone: 'auto' as string,
  },
});

export function homeDir() {
  return process.env.OLLAMACODE_HOME || path.join(os.homedir(), '.ollamacode');
}

export function configFile() {
  return path.join(homeDir(), 'config.json');
}

/** Settings that live under "agent" in config.json. */
const AGENT_KEYS: ReadonlySet<string> = new Set([...Object.keys(DEFAULTS.agent), 'contextBudget', 'afterEdit', 'beforeDone', 'checkTimeoutMs', 'subagentRoles']);

/**
 * An agent setting written at the top level of config.json (a snippet pasted without its "agent": { } wrapper) is read
 * as if it were inside "agent"; one set inside "agent" wins. Left where it was, it was ignored without a word.
 */
function liftAgentKeys(parsed: any): any {
  const lifted = Object.fromEntries(Object.entries(parsed).filter(([k]) => AGENT_KEYS.has(k) && !(k in DEFAULTS)));
  if (Object.keys(lifted).length === 0) return parsed;
  const rest = Object.fromEntries(Object.entries(parsed).filter(([k]) => !(k in lifted)));
  const agent = parsed.agent && typeof parsed.agent === 'object' ? parsed.agent : {};
  return { ...rest, agent: { ...lifted, ...agent } };
}

function deepMergeDefaults(parsedIn: any): TcConfig {
  const base = structuredClone( (DEFAULTS as TcConfig));
  if (!parsedIn || typeof parsedIn !== 'object') return base;
  const parsed = liftAgentKeys(parsedIn);
  for (const k of Object.keys(parsed)) {
    const incoming = parsed[k];
    const current = (base as any)[k];
    if (
      incoming !== null &&
      typeof incoming === 'object' &&
      !Array.isArray(incoming) &&
      current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)
    ) {
 (base as any)[k] = { ...current, ...incoming };
    } else {
 (base as any)[k] = incoming;
    }
  }
  return base;
}

/** Bumped when what config.json holds changes meaning. 2: only settings that differ from the defaults are written. */
const CONFIG_VERSION = 3;

/** Defaults that have since changed, each with the version whose files may still hold it as if it were chosen. */
const OLD_AGENT_DEFAULTS: ReadonlyArray<{ key: string; value: unknown; before: number }> = [
  // Before version 2 every default was written into the file.
  { key: 'temperature', value: 0.2, before: 2 },
  // 24 steps a turn was the default until version 3; a version-2 file saved after it changed kept a 24 read from an
  // older file as though chosen, and an approved plan stopped after a few of its steps.
  { key: 'maxIterations', value: 24, before: 3 },
];

/** A file from an older version can hold a default as it was then: an old default reads as the person's choice. */
function dropOldDefaults(parsed: any): any {
  if (!parsed || typeof parsed !== 'object' || !parsed.agent || typeof parsed.agent !== 'object') return parsed;
  const version = Number(parsed.configVersion ?? 0);
  const agent = { ...parsed.agent };
  for (const { key, value, before } of OLD_AGENT_DEFAULTS) {
    if (version < before && agent[key] === value) delete agent[key];
  }
  return { ...parsed, agent };
}

/** The settings that differ from the defaults: a default left in the file would outlive a change to it. */
function withoutDefaults(cfg: TcConfig): Record<string, unknown> {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    const def = (DEFAULTS as any)[key];
    if (value && def && typeof value === 'object' && typeof def === 'object' && !Array.isArray(value) && !Array.isArray(def)) {
      const section = Object.fromEntries(Object.entries(value).filter(([k, v]) => v !== undefined && !same(v, def[k])));
      if (Object.keys(section).length) out[key] = section;
    } else if (value !== undefined && !same(value, def)) {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig(): TcConfig {
  try {
    return deepMergeDefaults(dropOldDefaults(JSON.parse(fs.readFileSync(configFile(), 'utf-8'))));
  } catch {
    return structuredClone( (DEFAULTS as TcConfig));
  }
}

export function writeJsonAtomic(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
  }
  try {
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
    }
  }
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
    }
  }
}

function saveConfig(cfg: TcConfig): TcConfig {
  writeJsonAtomic(configFile(), { ...withoutDefaults(cfg), configVersion: CONFIG_VERSION });
  return cfg;
}

export function updateConfig(mutator: (cfg: TcConfig) => void) {
  const cfg = loadConfig();
  mutator(cfg);
  return saveConfig(cfg);
}

export function agentConfig(): AgentConfig {
  return loadConfig().agent;
}

export function mcpServersConfig(): McpServerConfig[] {
  return loadConfig().mcpServers ?? [];
}

