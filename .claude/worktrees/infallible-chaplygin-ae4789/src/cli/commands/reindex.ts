import path from 'node:path';
import { cyan, dim, green, red, yellow, icons } from '../../ui/ansi';
import { clearWorkspaceIndex, getWorkspaceStats, openWorkspaceIndex, pruneWorkspaceIndex } from '../../context/workspace-index/open';

type WorkspaceStats = NonNullable<Awaited<ReturnType<typeof getWorkspaceStats>>>;

/** Shared by `ocode reindex status` and `/reindex status` — the report line-for-line is identical, only the surrounding write() differs. */
export function renderIndexStats(stats: WorkspaceStats): string {
  return (
    `${cyan('workspace.db')} ${dim(stats.path)}\n` +
    `  size: ${(stats.size / 1024).toFixed(1)}KB (${stats.pages} pages)\n` +
    `  workspaces: ${stats.workspaces}${stats.duplicateWorkspaces ? yellow(` (${stats.duplicateWorkspaces} duplicate case-variant)`) : ''}\n` +
    `  projects: ${stats.projects}  files: ${stats.files}  symbols: ${stats.symbols}\n` +
    `  dependencies: ${stats.dependencies}  commands: ${stats.commands}${stats.orphanCommands ? red(` (${stats.orphanCommands} orphan)`) : ''}\n`
  );
}

export function indexNeedsAttention(stats: Pick<WorkspaceStats, 'duplicateWorkspaces' | 'orphanCommands'>): boolean {
  return Boolean(stats.duplicateWorkspaces || stats.orphanCommands);
}

export async function run(flags: any, rest: string[] = []) {
  const root = path.resolve(String(flags.scope || flags.root || process.cwd()));
  const sub = String(rest[0] ?? '').toLowerCase();

  if (sub === 'status') {
    const stats = await getWorkspaceStats(root);
    if (!stats) {
      process.stdout.write(`${dim('no workspace.db — nothing indexed yet')}\n`);
      return;
    }
    process.stdout.write(renderIndexStats(stats));
    if (indexNeedsAttention(stats)) {
      process.stdout.write(`${dim('run ocode reindex prune to dedupe + vacuum, or ocode reindex clear to delete')}\n`);
    }
    return;
  }

  if (sub === 'prune' || sub === 'vacuum' || sub === 'clean') {
    process.stdout.write(`${cyan(icons.arrow)} pruning workspace index…\n`);
    const res = await pruneWorkspaceIndex(root);
    process.stdout.write(
      `${green(icons.ok)} pruned — ${res.duplicateWorkspaces} duplicate workspace(s), ` +
        `${res.orphanCommands} orphan command(s), ${res.orphanFiles} file(s), ${res.orphanDeps} dep(s)` +
        `${res.vacuumed ? `, vacuumed ${res.before}→${res.after} bytes` : ''}\n`
    );
    // Reopen to refresh handle if needed
    try {
      const handle = await openWorkspaceIndex(root);
      await handle?.close();
    } catch {}
    return;
  }

  if (sub === 'clear' || sub === 'delete' || sub === 'reset') {
    process.stdout.write(`${cyan(icons.arrow)} clearing workspace index…\n`);
    const res = await clearWorkspaceIndex(root);
    process.stdout.write(res.removed ? `${green(icons.ok)} workspace.db cleared (${res.path})\n${dim('next run will rebuild it')}\n` : `${dim('nothing to clear')}\n`);
    return;
  }

  if (sub && sub !== 'rebuild' && sub !== 'force') {
    process.stdout.write(`${yellow(icons.warn)} unknown reindex subcommand "${sub}" — use prune|clear|status or no args for rebuild\n`);
  }
  process.stdout.write(`${cyan(icons.arrow)} rebuilding workspace index from scratch…\n`);
  const handle = await openWorkspaceIndex(root, { force: true });
  const count = handle?.projects?.length ?? 0;
  process.stdout.write(count ? `${green(icons.ok)} workspace reindexed — ${count} project(s)\n` : `${dim('no projects found — index rebuilt empty')}\n`);
  try { await handle?.close(); } catch {}
}
