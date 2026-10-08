import { APPROVAL, type ApprovalVerdict } from '../../../protocol';
import { PermissionPolicy, confirmOf, type ApproveFn } from '../../../tool/policy/permission-policy';
import { confirmRisky } from '../../../ui/prompts';
import { describeCall } from '../../../tool/core/tool-call';
import { resolveYes } from '../../flags';
import { previewCall } from '../render';
import { holdingTerminal } from './holding-terminal';
import type { ChatTurnContext } from './context';
import type { ToolDef } from '../../../types';

type PromptCall = { name: string; args: Record<string, unknown>; dangerous?: string; confirm?: string };

type PromptFn = (question: string, call: PromptCall) => Promise<string>;

export function createPromptFn(host: ChatTurnContext, signal: AbortSignal): PromptFn {
  const { render, workspace } = host;
  return async (question: string, call: PromptCall) => {
    const preview = await previewCall(workspace, call);
    if (preview?.block) render.preview(call.name, preview.block);
    // The preview names the action better, but the question's other lines say why it is being asked.
    const [, ...why] = question.split('\n');
    const shown = preview?.question ? [preview.question, ...why].join('\n') : question;
    const ans = await holdingTerminal(host, () =>
      confirmRisky(shown, { danger: call.dangerous, confirm: call.confirm, alwaysScope: 'routine changes this session', signal })
    );
    if (ans === 'always') render.note('→ won\'t ask again this session for routine changes; deletes, git pushes and merges, and risky commands still ask', 'dim');
    if (ans === 'no') render.note('→ declined; the model is told the call did not run', 'dim');
    return ans;
  };
}

// An answer the prompt never offered (dismissed, stray key) means nobody agreed: a cancellation, never a yes.
function verdictFromAnswer(ans: unknown): ApprovalVerdict {
  if (ans === 'yes') return true;
  if (ans === 'no') return false;
  return APPROVAL.CANCELLED;
}

export function createApproveFn(host: ChatTurnContext, promptFn: PromptFn): ApproveFn {
  const { workspace, agentState, interactive, cfg, flags } = host;
  const policy = new PermissionPolicy();

  return async (name, args, def, reason) => {
    const decision = await policy.decide({
      toolName: name,
      args,
      toolDef: def,
      cwd: workspace.cwd,
      // The workspace has no root of its own: its state holds it (the scope root, or the folder ocode started in).
      root: workspace.state?.root ?? workspace.cwd,
      permissions: agentState.permissions,
      yes: resolveYes(flags),
      policy: cfg.permissions.risky as 'ask' | 'always' | 'never',
      interactive,
      grantedRoots: workspace.state?.grantedRoots,
    });

    if (decision === 'allow' || decision === 'always') {
      if (decision === 'always') {
        agentState.permissions.alwaysAllowTools.add(name);
      }
      return true;
    }
    if (decision === 'deny') {
      return APPROVAL.REFUSED;
    }
    if (!interactive) {
      return APPROVAL.UNAVAILABLE;
    }
    // Line one is the question; any further lines say why it is being asked.
    const action = describeCall(def ?? { name }, args);
    const why = reason?.outside
      ? [`Outside the workspace: ${reason.outside.join(', ')}`]
      : reason?.outsideScope
        ? [`Outside the current task: ${reason.outsideScope.join(', ')}`]
        : [];
    const question = [action, ...why].join('\n');
    // A path outside the workspace is asked about every time: an "always" there would open more than this one call.
    const confirm = confirmOf(def ?? ({ name } as ToolDef), args, { cwd: workspace.cwd, root: workspace.state?.root ?? workspace.cwd, state: workspace.state })
      ?? (reason?.outside ? 'reaches outside the workspace' : undefined);
    const ans = await promptFn(question, { name, args, dangerous: reason?.dangerous ?? undefined, confirm });
    if (ans === 'always') {
      agentState.permissions.alwaysAllowTools.add(name);
      agentState.permissions.alwaysAllowAll = true;
      return true;
    }
    return verdictFromAnswer(ans);
  };
}
