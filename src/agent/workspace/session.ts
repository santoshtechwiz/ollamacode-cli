import { logger } from '../../core/logger';
import { agentConfig, DEFAULTS } from '../../core/config';
import { detectRuntimes, detectStacks } from '../../env/tooling/detector';
import { createToolingManager, refreshPathFromDetected } from '../../env/tooling/manager';
import { createWorkspaceState } from '../../context/workspace-state';
import { openWorkspaceIndex } from '../../context/workspace-index/open';
import { ensureMemory } from '../../context/memory';
import { ensureOwnExclude } from '../../tool/git/_git';
import { startMcpServers, mcpLoaderTool } from '../../mcp/registry';
import { isThinkingMode, type ThinkingMode } from '../../protocol';
import { registerDynamicTools } from '../../tool/index';
import { resolveScope } from './scope';
import { refreshModelCapabilities } from './profile';

export interface Workspace {
  cwd: string;
  state: import('../../context/workspace-state.ts').WorkspaceState;
  stacks: import('../../types.ts').StackInfo[];
  runtimes: Record<string, import('../../types.ts').RuntimeInfo>;
  db?: import('better-sqlite3').Database | null;
  projects?: Array<{ id: number; root: string; name: string; marker: string | null; stacks: import('../../types.ts').StackInfo[]; }>;
  index?: import('../../context/workspace-index/_shared.ts').IndexHandle | null;
  contextLength?: number;
  contextWindow?: number;
  maxTokens?: number;
  windowChosen?: boolean;
  maxTokensChosen?: boolean;
  nativeTools?: boolean;
  supportsThinking?: boolean;
  reasoningLeaks?: boolean;
  /** Resolved once per session and threaded in on `config`; the loop may only turn it off. */
  thinkingEnabled?: boolean;
  /** Why thinking is off despite the model supporting it — `null` when it isn't. */
  thinkingSuppressed?: import('./thinking.ts').ThinkingSuppression | null;
  /** A `/think` or `--think` choice for this session; outranks the config default. */
  thinkingPreference?: ThinkingMode;
  /** The model these measurements and budgets belong to. */
  model?: string;
  /** Measured generation rate, best seen for `model`. The only real speed signal. */
  tokensPerSec?: number;
  cpuOnly?: boolean;
  remote?: boolean;
  /** As the backend reports it ("4.0B"); unset when it reports none, as cloud models usually do. */
  parameterSize?: string;
  /** Models whose coding fitness was already shown this session, so it is said once per model. */
  fitShownFor?: Set<string>;
  tunnel?: boolean;
  autoContext?: string;
  /** Identity of the OLLAMACODE.md the cached block was built from; a change re-reads it. */
  autoContextStamp?: string;
  /** Identity of the index the cached block's project map was built from (`IndexHandle.stamp`); a rebuild re-reads it. */
  autoContextIndexStamp?: string;
}

/** Once-per-session environment discovery. */
export async function inspectWorkspace(cwd: string, { sessionId, provider, model, scope, contextWindow, maxTokens, thinking }: any = {}): Promise<Workspace> {
  if (!sessionId) {
    throw new Error('inspectWorkspace requires a sessionId — mint one with newSessionId(), or pass EPHEMERAL_SESSION for a context with no durable conversation');
  }
  const resolvedRoot = resolveScope(cwd, scope);
  const [runtimes, stacks] = await Promise.all([detectRuntimes(), detectStacks(resolvedRoot)]);

  try {
    await refreshPathFromDetected(runtimes);
  } catch (err) {
    logger.debug(`session PATH refresh unavailable: ${(err as Error).message}`);
  }

  // MCP servers connect in the background; their tools join the registry when they are up.
  startMcpServers((mcpTools) => {
    registerDynamicTools(mcpTools, { deferred: true });
    registerDynamicTools([mcpLoaderTool(mcpTools)]);
  });

  try {
    ensureMemory(resolvedRoot, stacks);
  } catch (err) {
    logger.debug(`project memory unavailable: ${(err as Error).message}`);
  }

  // Keep CLI records out of git status.
  try {
    await ensureOwnExclude(resolvedRoot);
  } catch (err) {
    logger.debug(`project state git-ignore unavailable: ${(err as Error).message}`);
  }

  let indexHandle: any = null;
  try {
    indexHandle = await openWorkspaceIndex(resolvedRoot);
  } catch (err) {
    logger.debug(`workspace index unavailable: ${(err as Error).message}`);
  }

  const state = createWorkspaceState(resolvedRoot, { sessionId });
  state.tooling = createToolingManager();
  state.stacks = stacks;
  state.index = indexHandle;
  const workspace = {
    cwd: resolvedRoot,
    state,
    stacks,
    runtimes,
    db: indexHandle?.db ?? null,
    projects: indexHandle?.projects ?? [],
    index: indexHandle,
    autoContext: undefined as string | undefined,
    autoContextStamp: undefined as string | undefined,
    autoContextIndexStamp: undefined as string | undefined,
    contextWindow: contextWindow ?? agentConfig().contextWindow,
    maxTokens: maxTokens ?? agentConfig().maxTokens,
    windowChosen: contextWindow !== undefined || agentConfig().contextWindow !== DEFAULTS.agent.contextWindow,
    maxTokensChosen: maxTokens !== undefined || agentConfig().maxTokens !== DEFAULTS.agent.maxTokens,
    thinkingPreference: isThinkingMode(thinking) ? thinking : undefined,
  };
  await refreshModelCapabilities(workspace, { provider, model });
  return workspace;
}
