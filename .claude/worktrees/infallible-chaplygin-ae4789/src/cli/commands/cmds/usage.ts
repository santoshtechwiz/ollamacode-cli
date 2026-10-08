import { bold, dim } from '../../../ui/ansi';
import { usageTotals, formatTokens, usageLine, type TurnUsage } from '../../../core/usage';
import { CmdResult } from './types';

/** How many of the heaviest turns /usage names. */
const HEAVIEST_TURNS = 5;

/** `/usage`: tokens sent to and received from models this session, by model, and the turns that cost the most. */
export async function runUsage(ctx: any): Promise<boolean | 'exit'> {
  const totals = usageTotals();
  if (totals.calls === 0) {
    ctx.write(`${dim('  no model calls yet this session')}\n`);
    return CmdResult.HANDLED;
  }
  const lines = [`  ${bold('session')}  ${usageLine(totals)}`];

  const models = Object.entries(totals.byModel).sort(([, a], [, b]) => b.sent - a.sent);
  if (models.length > 1) {
    for (const [model, u] of models) {
      lines.push(dim(`    ${model}: ${usageLine(u, 'call')}`));
    }
  }

  const turns: TurnUsage[] = [...(ctx.turnUsage ?? [])].sort((a, b) => b.sent - a.sent).slice(0, HEAVIEST_TURNS);
  if (turns.length > 0) {
    lines.push(`  ${bold('heaviest turns')}`);
    for (const t of turns) {
      lines.push(dim(`    ${usageLine(t, 'call', [6, 5])} — ${t.request || '(continue)'}`));
    }
  }

  const budget = ctx.history?.budgetTokens;
  lines.push(dim(`  history budget: ${budget ? `${formatTokens(budget)} tokens (agent.contextBudget)` : 'sized from the model window'}`));
  if (totals.estimated > 0) lines.push(dim(`  ~ marks counts ocode estimated because the backend reported none for ${totals.estimated} call${totals.estimated === 1 ? '' : 's'}`));
  lines.push(dim('  sent counts the whole prompt of every call; a local backend may reuse part of it from cache, which saves time but not the count'));
  ctx.write(`${lines.join('\n')}\n`);
  return CmdResult.HANDLED;
}
