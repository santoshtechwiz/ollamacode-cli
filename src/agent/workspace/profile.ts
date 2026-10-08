// Workspace profile: context window budget and what the model can do.
import { logger } from '../../core/logger';
import { DEFAULTS } from '../../core/config';
import { REASONING_MIN_PREDICT, REASONING_RESERVE_FRACTION } from '../../protocol';
import type { Workspace } from './session';
import { resolveThinking } from './thinking';
import { judgeModel, type ModelVerdict } from './model-fit';
import { buildSystemPrompt } from '../../prompts/system';
import { textModeInstructions } from '../../prompts/tools';
import { estimateTokens } from '../../context/tokens';

// Budget (from budget.ts)
function generationAffordable({ cpuOnly, remote }: { cpuOnly?: boolean; remote?: boolean; }): boolean {
  return remote === true || cpuOnly === false;
}

export function resolveSessionBudget(workspace: Workspace, { declared, cpuOnly, remote }: { declared: number; cpuOnly?: boolean; remote?: boolean; }): void {
  if (!workspace.windowChosen) {
    const cap = remote ? REMOTE_SESSION_WINDOW : SESSION_WINDOW;
    const unknownFallback = remote ? REMOTE_UNKNOWN_WINDOW : SESSION_WINDOW;
    (workspace as any).contextWindow = declared > 0 ? Math.min(cap, declared) : unknownFallback;
  }
  if (!(workspace as any).maxTokensChosen) {
    const window = Number((workspace as any).contextWindow) || 0;
    // 40% of the window, but never past what models commonly allow in one reply: a model with a smaller limit says so
    // when refused, and the gateway learns it from that.
    const ceiling = window > 0 ? Math.min(MAX_REPLY_TOKENS, Math.floor(window * REASONING_RESERVE_FRACTION)) : REASONING_MIN_PREDICT;
    // Where generation is affordable (a hosted model, a GPU) a reply gets the room any model gets: thinking counts against
    // it, and a thinking model capped at 2048 was cut off mid-edit. Only a CPU-only machine, where long reasoning costs
    // minutes, keeps a thinking model to the small cap.
    if (generationAffordable({ cpuOnly, remote })) {
      (workspace as any).maxTokens = ceiling;
    } else if ((workspace as any).thinkingEnabled) {
      (workspace as any).maxTokens = Math.min(REASONING_MIN_PREDICT, ceiling);
    } else {
      (workspace as any).maxTokens = DEFAULTS.agent.maxTokens;
    }
  } else if ((workspace as any).thinkingEnabled && Number((workspace as any).maxTokens) < REASONING_MIN_PREDICT) {
    logger.debug(
      `agent.maxTokens is ${(workspace as any).maxTokens} and this model reasons before it answers; ` +
        'thinking tokens count against that budget. Raise agent.maxTokens, or run /think hide.',
    );
  }
  const window = Number((workspace as any).contextWindow) || 0;
  (workspace as any).contextLength = declared > 0 && window ? Math.min(declared, window) : declared > 0 ? declared : undefined;
}

const SESSION_WINDOW = 32_768;
const REMOTE_SESSION_WINDOW = 200_000;
/** The most one reply is asked for by default: plenty for any edit, and within what most models accept. */
export const MAX_REPLY_TOKENS = 32_768;
const REMOTE_UNKNOWN_WINDOW = 131_072;
const SMALL_WINDOW = 8192;
const MEDIUM_WINDOW = 32_768;

const LEAN_PROFILE = { brief: true, compact: true, core: true, autoContextBudget: 1200 };
const MEDIUM_PROFILE = { brief: false, compact: true, core: true, autoContextBudget: 3000 };
const REMOTE_UNKNOWN_BUDGET = { autoContextBudget: 1800 };
const REMOTE_MEDIUM_BUDGET = { autoContextBudget: 2200 };

export function chooseProfile(contextLength?: number, { cpuOnly, remote }: any = {}): { brief: boolean; compact: boolean; core: boolean; autoContextBudget: number } {
  if (cpuOnly) return { ...LEAN_PROFILE };
  const known = Number(contextLength);
  const declared = Number.isFinite(known) && known > 0;
  if (remote && !declared) return { ...LEAN_PROFILE, ...REMOTE_UNKNOWN_BUDGET };
  const window = declared ? known : remote ? MEDIUM_WINDOW : SMALL_WINDOW;
  if (window <= SMALL_WINDOW) return { ...LEAN_PROFILE };
  // A bigger window buys no bigger prompt: the builder's tiers grow history only when the task needs it.
  return { ...MEDIUM_PROFILE, ...(remote ? REMOTE_MEDIUM_BUDGET : {}) };
}

export async function refreshModelCapabilities(workspace: Workspace, { provider, model }: any = {}): Promise<{ contextLength?: number; nativeTools: boolean; cpuOnly?: boolean; remote: boolean; supportsTools?: boolean; supportsThinking?: boolean; tunnel?: boolean }> {
  const info = provider as any;
  let meta: any = {};
  let cpuOnly: boolean | undefined;
  if (model && typeof info?.modelInfo === 'function') {
    const modelInfoP = info.modelInfo(model).catch((err: unknown) => {
      logger.debug(`model capability probe failed: ${(err as Error).message}`);
      return {};
    });
    const cpuP = typeof info?.isCpuOnly === 'function'
      ? info.isCpuOnly(model).catch((err: unknown): undefined => {
          logger.debug(`cpu probe failed: ${(err as Error).message}`);
          return undefined;
        })
      : Promise.resolve(undefined);
    const [m, c] = await Promise.all([modelInfoP, cpuP]);
    meta = m ?? {};
    cpuOnly = c as any;
  }
  if (model && (workspace as any).model !== model) {
    (workspace as any).model = model;
    (workspace as any).tokensPerSec = undefined;
    (workspace as any).thinkingSuppressed = null;
  }
  const remote = Boolean(meta.remote);
  if (remote) cpuOnly = undefined;
  const declared = Number(meta.contextLength);
  (workspace as any).nativeTools = meta.supportsTools !== false;
  (workspace as any).supportsThinking = meta.supportsThinking;
  (workspace as any).cpuOnly = cpuOnly;
  (workspace as any).remote = remote;
  workspace.parameterSize = typeof meta.parameterSize === 'string' ? meta.parameterSize : undefined;
  resolveThinking(workspace as any);
  resolveSessionBudget(workspace as any, { declared, cpuOnly, remote });
  // A tunnel is the connection (an ngrok or https address that can drop without a word), not the model: a cloud model
  // served through the local daemon thinks for long silent stretches, and the tunnel's short idle limit cut it off.
  (workspace as any).tunnel = typeof (provider as any)?._base === 'function' ? /ngrok|https:/i.test(String(await (provider as any)._base() ?? '')) : false;
  return {
    contextLength: meta.contextLength,
    nativeTools: (workspace as any).nativeTools,
    cpuOnly,
    remote,
    supportsTools: meta.supportsTools,
    supportsThinking: (workspace as any).supportsThinking,
    tunnel: (workspace as any).tunnel,
  };
}

/**
 * Whether the window left after the reply budget holds the system prompt with tools written into it as text, the way
 * a model without native tool calling is sent them. Unknown windows count as fitting: nothing says they do not.
 */
export function textToolsFit(workspace: Workspace): boolean {
  const ws = workspace as any;
  const window = Number(ws.contextWindow) || 0;
  if (window <= 0) return true;
  const room = window - (Number(ws.maxTokens) || 0);
  const profile = chooseProfile(ws.contextLength ?? ws.contextWindow, { cpuOnly: ws.cpuOnly, remote: ws.remote });
  const prompt = buildSystemPrompt({ cwd: ws.cwd, stacks: ws.stacks, runtimes: ws.runtimes, toolsEnabled: true, brief: profile.brief });
  return estimateTokens(prompt + textModeInstructions({ core: profile.core })) < room;
}

/** The session model's coding fitness, or null when it was already shown this session. */
export function modelFitOnce(workspace: Workspace): ModelVerdict | null {
  const model = String((workspace as any).model ?? '');
  if (!model) return null;
  const shown = (workspace.fitShownFor ??= new Set());
  if (shown.has(model)) return null;
  shown.add(model);
  return judgeModel({
    model,
    nativeTools: (workspace as any).nativeTools,
    parameterSize: workspace.parameterSize,
    contextLength: (workspace as any).contextLength,
    cpuOnly: (workspace as any).cpuOnly,
    remote: (workspace as any).remote,
  });
}

export function describeCapabilities(workspace: Workspace): string {
  const nativeTools = (workspace as any).nativeTools !== false;
  return [
    (workspace as any).remote ? 'remote' : null,
    (workspace as any).contextLength ? `ctx ${(workspace as any).contextLength}` : 'ctx unknown',
    nativeTools ? 'native tools' : 'text tools',
    nativeTools ? null : 'no native tool calling',
    (workspace as any).cpuOnly ? 'cpu-only' : null,
    (workspace as any).supportsThinking ? ((workspace as any).thinkingEnabled ? 'thinking on' : 'thinking off') : null,
  ].filter(Boolean).join(' · ');
}
