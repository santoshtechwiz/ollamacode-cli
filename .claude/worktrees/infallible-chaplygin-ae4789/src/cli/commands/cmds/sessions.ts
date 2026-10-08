import { bold, dim, green, icons, red } from '../../../ui/ansi';
import { listSessions, sessionTitle } from '../../../core/sessions';
import { relativeTime } from '../../chat/session';
import { CmdResult } from './types';

/** `/sessions` lists this workspace's conversations, newest first; `/sessions <n>` carries on the n-th one here. */
export async function runSessions(ctx: any, arg: string = ''): Promise<boolean | 'exit'> {
  const all = listSessions(ctx.sessionsRoot);
  const current = ctx.currentSessionId?.();
  const pick = Number.parseInt(String(arg).trim(), 10);
  if (String(arg).trim()) {
    const rec = Number.isFinite(pick) ? all[pick - 1] : undefined;
    if (!rec) {
      ctx.write(`  ${red(icons.error ?? '✖')} ${dim(`no session ${String(arg).trim()} — /sessions lists them`)}\n`);
      return CmdResult.HANDLED;
    }
    const why = ctx.switchSession(rec);
    ctx.write(why
      ? `  ${dim(`can't switch: ${why}`)}\n`
      : `  ${green(icons.ok)} continuing ${bold(sessionTitle(rec))} ${dim(`— ${rec.messages.length} messages; the session you left is kept in /sessions`)}\n`);
    return CmdResult.HANDLED;
  }
  if (all.length === 0) {
    ctx.write(`  ${dim('No saved sessions in this folder yet.')}\n`);
    return CmdResult.HANDLED;
  }
  all.forEach((rec, i) => {
    const here = rec.id === current;
    ctx.write(`  ${here ? green('●') : ' '} ${String(i + 1).padStart(2)}  ${here ? bold(sessionTitle(rec)) : sessionTitle(rec)}  ${dim(`${relativeTime(rec.updatedAt ?? rec.createdAt ?? 0, Date.now())} · ${rec.messages.length} messages`)}\n`);
  });
  ctx.write(`  ${dim('/sessions <n> carries one on here; /clear starts a new one. The newest 10 are kept.')}\n`);
  return CmdResult.HANDLED;
}
