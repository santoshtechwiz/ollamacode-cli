import path from 'node:path';

import { cyan, dim, green, yellow } from '../../../ui/ansi';
import { CmdResult } from './types';
import { undoLast, sessionHasLedger } from '../../../core/session-recovery';

export async function runUndo(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const sessionId = ctx.sessionId;
  const root = ctx.workspace?.state?.root;
  if (!sessionHasLedger(sessionId) || !root) {
    ctx.write(`  ${yellow('!')} no recovery ledger is available for this session\n`);
    return CmdResult.HANDLED;
  }

  const rawPath = String(arg ?? '').trim();
  let rel: string | undefined;
  if (rawPath) {
    const abs = path.resolve(root, rawPath);
    rel = path.relative(root, abs).split(path.sep).join('/') || '.';
    if (rel === '.' || rel.startsWith('.ollamacode/')) {
      ctx.write(`  ${yellow('!')} cannot undo that path\n`);
      return CmdResult.HANDLED;
    }
  }

  try {
    const outcome = await undoLast(root, sessionId, rel);
    if (!outcome) {
      ctx.write(`  ${dim('nothing to undo')}${rel ? ` for ${cyan(rel)}` : ''}\n`);
      return CmdResult.HANDLED;
    }
    const { entry, action } = outcome;
    ctx.write(
      `  ${green('✓')} ${action === 'restored' ? 'restored' : 'removed'} ${cyan(entry.rel)} ` +
        `(reverted ${entry.tool})\n`
    );
  } catch (err) {
    ctx.write(`  ${yellow('!')} could not undo: ${(err as Error)?.message ?? String(err)}\n`);
  }
  return CmdResult.HANDLED;
}