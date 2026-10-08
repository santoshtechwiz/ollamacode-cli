import { cyan, dim, green, icons, red, yellow } from '../../../ui/ansi';
import { openWorkspaceIndex, getWorkspaceStats, pruneWorkspaceIndex, clearWorkspaceIndex } from '../../../context/workspace-index/open';
import { logger } from '../../../core/logger';
import { renderIndexStats, indexNeedsAttention } from '../reindex';
import { CmdResult } from './types';

/** `/reindex` — rebuild the workspace index from scratch, plus prune/clear/status. */
export async function runReindex(ctx: any, arg?: string): Promise<boolean | 'exit'> {
  const workspace = ctx.workspace;
  const sub = String(arg ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  if (!workspace?.cwd) {
    ctx.write(`${yellow(icons.warn)} no workspace to reindex\n`);
    return CmdResult.HANDLED;
  }

  if (sub === 'status') {
    const stats = await getWorkspaceStats(workspace.cwd);
    if (!stats) {
      ctx.write(`${dim('  no workspace.db — nothing indexed yet')}\n`);
      return CmdResult.HANDLED;
    }
    ctx.write(renderIndexStats(stats));
    if (indexNeedsAttention(stats)) {
      ctx.write(`${dim('  run /reindex prune to dedupe + vacuum, or /reindex clear to delete')}\n`);
    }
    return CmdResult.HANDLED;
  }

  if (sub === 'prune' || sub === 'vacuum' || sub === 'clean') {
    ctx.write(`${cyan(icons.arrow)} pruning workspace index…\n`);
    try {
      const old = workspace.index as { close: () => Promise<void>; } | null | undefined;
      try { await old?.close(); } catch {}
      const res = await pruneWorkspaceIndex(workspace.cwd);
      const handle = await openWorkspaceIndex(workspace.cwd);
      workspace.index = handle;
      workspace.db = (handle as any)?.db ?? null;
      workspace.projects = (handle as any)?.projects ?? [];
      if (workspace.state) (workspace.state as any).index = handle;
      workspace.autoContext = undefined; workspace.autoContextStamp = undefined; workspace.autoContextIndexStamp = undefined;
      ctx.write(
        `${green(icons.ok)} pruned — ${res.duplicateWorkspaces} duplicate workspace(s), ` +
          `${res.orphanCommands} orphan command(s), ${res.orphanFiles} file(s), ${res.orphanDeps} dep(s)` +
          `${res.vacuumed ? `, vacuumed ${res.before}→${res.after} bytes` : ''}\n`
      );
    } catch (err) {
      ctx.write(`${red(`  prune failed: ${(err as Error).message}`)}\n`);
    }
    return CmdResult.HANDLED;
  }

  if (sub === 'clear' || sub === 'delete' || sub === 'reset') {
    ctx.write(`${cyan(icons.arrow)} clearing workspace index…\n`);
    try {
      const old = workspace.index as { close: () => Promise<void>; } | null | undefined;
      try { await old?.close(); } catch {}
      const res = await clearWorkspaceIndex(workspace.cwd);
      workspace.index = null; workspace.db = null; workspace.projects = [];
      if (workspace.state) (workspace.state as any).index = null;
      workspace.autoContext = undefined; workspace.autoContextStamp = undefined; workspace.autoContextIndexStamp = undefined;
      ctx.write(res.removed ? `${green(icons.ok)} workspace.db cleared (${res.path})\n${dim('  next turn will rebuild it')}\n` : `${dim('  nothing to clear')}\n`);
    } catch (err) {
      ctx.write(`${red(`  clear failed: ${(err as Error).message}`)}\n`);
    }
    return CmdResult.HANDLED;
  }

  const old = workspace.index as { close: () => Promise<void>; } | null | undefined;
  try {
    await old?.close();
  } catch (err) {
    logger.warn(`/reindex could not close the previous index (${(err as Error).message})`);
  }
  ctx.write(`${cyan(icons.arrow)} rebuilding the workspace index from scratch…\n`);
  try {
    const handle = await openWorkspaceIndex(workspace.cwd, { force: true });
    workspace.index = handle;
    workspace.db = handle?.db ?? null;
    workspace.projects = handle?.projects ?? [];
    if (workspace.state) workspace.state.index = handle;
    // The auto-context block derives from the index and caches per index stamp; a fresh stamp (opened_at changed with the reopen) invalidates it.
    workspace.autoContext = undefined;
    workspace.autoContextStamp = undefined;
    workspace.autoContextIndexStamp = undefined;
    const count = handle?.projects?.length ?? 0;
    ctx.write(count ? `${green(icons.ok)} workspace reindexed — ${count} project(s)\n` : `${dim('  no projects found — index rebuilt empty')}\n`);
  } catch (err) {
    ctx.write(`${red(`  reindex failed: ${(err as Error).message}`)}\n`);
  }
  return CmdResult.HANDLED;
}