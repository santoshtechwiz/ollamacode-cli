import { bold, dim, green, red, yellow } from '../../../ui/ansi';
import { CmdResult } from './types';

export async function runPlans(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const { listPlans, getActivePlan, summarizeRecord } = await import('../../../agent/planning/store.ts');
  const recs = listPlans();
  if (recs.length === 0) {
    ctx.write(`${dim('  No plan open.')}\n`);
    return CmdResult.HANDLED;
  }
  const n = Math.max(1, Number.parseInt(String(arg ?? '').split(/\s+/).filter(Boolean)[0] ?? '', 10) || 10);
  let activeId: any = null;
  try {
    activeId = getActivePlan(ctx.workspace?.cwd)?.id ?? null;
  } catch { /* listing never depends on the pointer */ }
  const rows = recs.slice(0, n).map((rec) => {
    const s = summarizeRecord(rec);
    if (!s) return null;
    const mark = s.id === activeId ? green(' ← resumable (/continue)') : '';
    const status =
      s.status === 'DONE' ? green('done') :
      s.status === 'FAILED' ? red('failed') :
      s.status === 'ACTIVE' ? yellow('active') :
      s.status === 'NEEDS_REPLAN' ? red('stuck — needs replan') :
      dim(String(s.status ?? '?').toLowerCase());
    return `  ${status} ${dim(`${s.done}/${s.total}`)} ${s.title}${mark}\n${dim(`    ${s.id} · ${s.createdAt ?? 'when unknown'}`)}`;
  }).filter(Boolean);
  ctx.write(
    `${bold('  plans')}${dim(' — newest first')}\n${rows.join('\n')}\n`
  );
  return CmdResult.HANDLED;
}
