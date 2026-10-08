import { ROLE } from '../../protocol';
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
import { workingProject } from '../../context/workspace-state';

type Message = import('../../types.ts').Message;

export type Profile = ReturnType<typeof chooseProfile>;

export async function buildTurnContext({
  workspace,
  toolsEnabled,
  input,
  includeAutoContext = true,
  signal,
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
        // Every project in the workspace, the same on every request: which one a request is about is the model's to read.
        stacks: workspace.stacks,
        runtimes: workspace.runtimes,
        toolsEnabled,
        brief: profile.brief,
      }),
    },
  ];


  const docRoot = workspace.state?.root ?? workspace.cwd;
  const projectDoc = findProjectDoc(docRoot, workingProject(workspace.state) ?? workspace.cwd);
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
