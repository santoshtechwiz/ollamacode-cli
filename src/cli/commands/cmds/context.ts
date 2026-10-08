import { dim } from '../../../ui/ansi';
import { summarizeTelemetry, formatTelemetry } from '../../../core/telemetry';
import { CmdResult } from './types';

export async function runContext(ctx: any): Promise<boolean | 'exit'> {
  const history = ctx.history;
  const ledger = ctx.workspace.state?.executions?.length ?? 0;
  const mode = ctx.showReasoning === 'detailed' ? 'detailed' : ctx.showReasoning ? 'show' : 'hide';
  ctx.write(`${dim(`  ~${history.tokenCount} tokens stored across ${history.messages.length} messages · history budget ${history.budgetTokens ?? 'sized from the model window'}`)}  ${dim(`ledger ${ledger} · ${mode}`)}\n`);

  const last = history.lastBudget;
  if (last) {
    const levels = last.levels.length ? ` · compacted ${last.levels.join(',')}` : '';
    const dropped = last.dropped ? ` · ${last.dropped} message(s) trimmed` : '';
    ctx.write(
      `${dim(`  last request ~${last.inputTokens} tokens (budget ${last.promptBudget} of ${last.contextLimit} window): ` +
        `system ${last.systemTokens} · tools ${last.toolSchemaTokens} · history ${last.historyTokens} · ` +
        `request ${last.requestTokens} · workspace ${last.trailingTokens}${levels}${dropped}`)}\n`
    );
  }

  // Where the session's time actually went.
  const telemetry = ctx.sessionTelemetry ?? [];
  if (telemetry.length > 0) {
    ctx.write(`${dim(`  ${formatTelemetry(summarizeTelemetry(telemetry))}`)}\n`);
  }
  return CmdResult.HANDLED;
}
