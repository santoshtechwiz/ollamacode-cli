import { cyan, dim } from '../../../ui/ansi';
import { loadConfig } from '../../../core/config';
import { describeCapabilities } from '../../../agent/workspace/profile';
import { currentProviderMode } from './provider';
import { modeLabel, modeOf } from '../../chat/mode';
import { CmdResult } from './types';

export async function runStatus(ctx: any): Promise<boolean | 'exit'> {
  const rows = [
    ['session', `${ctx.resumable ? 'continued' : 'new'} · ${ctx.history.messages.length} messages`],
    ['model', `${ctx.session.provider.label} · ${ctx.session.model}`],
    ['provider mode', currentProviderMode()],
    ['', describeCapabilities(ctx.workspace)],
    ['workspace', ctx.workspace.state.root],
    ['tools', ctx.toolsEnabled ? 'on' : 'off — /tools to enable'],
    ['mode', modeLabel(modeOf({ planMode: ctx.planMode, reviewMode: ctx.reviewMode, askMode: ctx.askMode }))],
    ['permissions', `risky tools: ${loadConfig().permissions.risky}`],
    ['tool output', ctx.expandTools ? 'expanded' : 'collapsed — /verbose to expand'],
    ...(ctx.workspace.supportsThinking
      ? [['thinking', ctx.showReasoning === 'detailed' ? 'detailed' : ctx.showReasoning ? 'shown' : 'hidden']]
      : []),
  ];
  ctx.write(`${rows.map(([k, v]: any) => `  ${cyan(k.padEnd(12))} ${dim(v)}`).join('\n')}\n`);
  return CmdResult.HANDLED;
}
