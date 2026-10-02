import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { THINKING_MODE, type ThinkingMode } from '../protocol';
import type { ProviderMode } from '../model/providers/mode';

export interface TcConfig {
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

export interface RoutingConfig {
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

export interface AgentConfig {
  maxIterations: number;
  idleTimeoutMs: number;
  firstTokenTimeoutMs: number;
  turnBudgetMs: number;
  toolTimeoutMs?: number;
  maxToolOutput: number;
  maxIterationOutput: number;
  /** History target in tokens; unset, it is sized from the model's window each request. */
  contextBudget?: number;
  maxRetries: number;
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
    maxIterations: 24,
    idleTimeoutMs: 120_000,
    firstTokenTimeoutMs: 300_000,
    turnBudgetMs: 900_000,
    toolTimeoutMs: 600_000,
    maxToolOutput: 8000,
  maxIterationOutput: 40_000,
    maxRetries: 2,
    temperature: 0.2,
    // The window the backend is driven at; resolveSessionBudget() clamps it to what the model declares.
    contextWindow: 32_768,
    maxTokens: 512,
    keepAlive: '30m',
    // `auto`: think where the model supports it and the backend can afford it.
    thinking: (THINKING_MODE.AUTO as ThinkingMode),
    memory: { enabled: true, maxChars: undefined },
  },
});

export function homeDir() {
  return process.env.OLLAMACODE_HOME || path.join(os.homedir(), '.ollamacode');
}

export function configFile() {
  return path.join(homeDir(), 'config.json');
}

function deepMergeDefaults(parsed: any): TcConfig {
  const base = structuredClone( (DEFAULTS as TcConfig));
  if (!parsed || typeof parsed !== 'object') return base;
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

export function loadConfig(): TcConfig {
  try {
    return deepMergeDefaults(JSON.parse(fs.readFileSync(configFile(), 'utf-8')));
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
  writeJsonAtomic(configFile(), cfg);
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

