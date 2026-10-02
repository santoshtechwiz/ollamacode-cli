import { ROLE, PLAN_STATUS } from '../../protocol';
import { AGENT_DIR_TRACKED_IN_GIT } from '../../prompts/planning';
import { buildSystemPrompt, buildContextMessages } from '../../prompts/system';
import { agentConfig } from '../../core/config';
import { logger } from '../../core/logger';
import { gatherContext } from '../../context/auto-context';
import { buildMentionContext } from '../../context/mentions';
import {
  findProjectDoc,
  loadMemory,
  parseConventionsFile,
  projectDocStamp,
  renderMemoryPrompt,
} from '../../context/memory';
import { chooseProfile } from '../workspace/profile';
import { resolveTaskScope } from '../../context/workspace-index/task-scope';
import { replanRequest } from '../../prompts/planning';
import { getActivePlan, getPlanPath } from '../planning/store';
import { relTo } from '../../tool/filesystem/_fs';

type Message = import('../../types.ts').Message;

export type Profile = ReturnType<typeof chooseProfile>;

export interface ReplanTrigger {
  planPath: string;
  input: string;
}

/** The person chose to continue a plan flagged for replanning: propose a fresh plan for what got stuck. */
export function detectReplan(workspace: any, continuing: boolean, toolsEnabled: boolean): ReplanTrigger | null {
  if (!toolsEnabled || !continuing) return null;
  const stuckPlan = getActivePlan(workspace.cwd);
  if (stuckPlan?.sessionId && workspace.state?.sessionId && stuckPlan.sessionId !== workspace.state.sessionId) return null;
  if (stuckPlan?.status !== PLAN_STATUS.NEEDS_REPLAN) return null;
  const replanInput = buildReplanInput(stuckPlan);
  return replanInput ? { planPath: getPlanPath(workspace.cwd), input: replanInput } : null;
}

/** Replan input from the stuck plan. Turn owns when to replan; this only shapes the input. */
function buildReplanInput(record: import('../planning/store.ts').PlanRecord | null | undefined): string | null {
  if (!record) return null;
  // No task tracking in store; use the original goal/task for replanning.
  // The planner will receive reason=VERIFICATION_FAILED and re-plan from scratch.
  const goal = record.task || record.title || 'the original request';
  return replanRequest({ task: goal, title: record.title }, []);
}

export function applyTaskScope(workspace: any, input: string, { onStatus }: { onStatus?: (s: string) => void }): any {
  if (!workspace?.index?.db) return null;
  const scope = resolveTaskScope(workspace.index, workspace.cwd, input);
  if (!scope || !workspace.state) return scope;
  workspace.state.scope = scope.roots;
  workspace.state.activeProject = scope.activeProject;
  if (scope.activeProject && scope.confidence === 'high') {
    onStatus?.(`Working on ${scope.activeProject.name} (${relTo(workspace.cwd, scope.activeProject.root)}) — matched from your request`);
  }
  return scope;
}

export async function buildTurnContext({
  workspace,
  toolsEnabled,
  input,
  includeAutoContext = true,
  signal,
  stacks,
}: any): Promise<{ system: Message[]; mentions: string[]; profile: Profile }> {
  // contextLength is already the driven window (declared, clamped by num_ctx).
  const profile = chooseProfile(workspace.contextLength ?? workspace.contextWindow, {
    cpuOnly: workspace.cpuOnly,
    remote: workspace.remote,
  });

  const system: Message[] = [
    {
      role: ROLE.SYSTEM,
      content: buildSystemPrompt({
        cwd: workspace.cwd,
        // A scope that matched no project narrows nothing: the workspace's own projects still apply.
        stacks: stacks?.length ? stacks : workspace.stacks,
        runtimes: workspace.runtimes,
        toolsEnabled,
        brief: profile.brief,
      }),
    },
  ];


  const docRoot = workspace.state?.root ?? workspace.cwd;
  const projectDoc = findProjectDoc(docRoot, workspace.state?.activeProject?.root ?? workspace.cwd);
  const docStamp = projectDocStamp(projectDoc);

  const indexStamp = workspace.index?.stamp ? workspace.index.stamp() : '';

  if (
    includeAutoContext &&
    (workspace.autoContext === undefined ||
      workspace.autoContextStamp !== docStamp ||
      workspace.autoContextIndexStamp !== indexStamp)
  ) {
    if (workspace.autoContext !== undefined || workspace.autoContextStamp !== undefined) {
      logger.debug('auto-context: project doc or index changed — re-reading it');
    }
    workspace.autoContext = await gatherContext(workspace.cwd, {
      signal,
      maxChars: profile.autoContextBudget,
      projectDoc,
      index: workspace.index ?? null,
    });
    workspace.autoContextStamp = docStamp;
    workspace.autoContextIndexStamp = indexStamp;
  }
  const rawAutoContext = includeAutoContext ? (workspace.autoContext ?? '') : '';
  const autoContext =
    rawAutoContext.length > profile.autoContextBudget
      ? rawAutoContext.slice(0, profile.autoContextBudget) + '\n…[truncated for budget]\n[/Auto-context]'
      : rawAutoContext;

  let memoryBlock = '';
  if (includeAutoContext) {
    const memCfg = (agentConfig().memory ?? {}) as { enabled?: boolean; maxChars?: number };
    if (memCfg.enabled !== false) {
      const maxChars = Number(memCfg.maxChars) || (profile.brief ? 600 : 1600);
      try {
        const root = workspace.state.root;
        memoryBlock = renderMemoryPrompt(loadMemory(root), {
          extraConventions: parseConventionsFile(root),
          maxChars,
        });
      } catch (err) {
        logger.debug(`project memory unavailable: ${(err as Error).message}`);
      }
    }
  }

  const mentionCtx = await buildMentionContext(input, workspace.cwd);

  system.push(...buildContextMessages({ autoContext, memory: memoryBlock, mentions: mentionCtx.block }));

  if (workspace.index?.gitTracked) {
    system.push({ role: ROLE.SYSTEM, content: AGENT_DIR_TRACKED_IN_GIT });
  }
  return { system, mentions: mentionCtx.mentions, profile };
}
