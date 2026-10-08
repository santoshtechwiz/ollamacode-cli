import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dim, green, icons } from '../../../ui/ansi';
import { CmdResult } from './types';

function resolveEditor(): { command: string; args: string[]; } {
  const fromEnv = String(process.env.VISUAL ?? process.env.EDITOR ?? '').trim();
  if (fromEnv) {
    const [command, ...args] = fromEnv.split(/\s+/).filter(Boolean);
    return { command, args };
  }
  if (process.platform === 'win32') return { command: 'notepad', args: [] };
  return { command: 'vi', args: [] };
}

/** Compose long input in $VISUAL/$EDITOR via a temp file, then queue it as the next message. */
export async function runEditor(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const seed = String(arg ?? '').trim() || String(ctx.draft?.() ?? '');
  const dir = mkdtempSync(join(tmpdir(), 'ocode-'));
  const file = join(dir, 'message.md');
  try {
    writeFileSync(file, seed ? `${seed}\n` : '', 'utf8');
  } catch (err) {
    ctx.write(`${dim(`  cannot open editor: ${(err as Error).message}`)}\n`);
    return CmdResult.HANDLED;
  }
  const { command, args } = resolveEditor();
  ctx.write(`${dim(`  opening ${command} — save and quit to send, empty file cancels`)}${'\n'}`);
  try {
    ctx.suspendInput?.();
    ctx.pauseRender?.();
    const res = spawnSync(command, [...args, file], { stdio: 'inherit' });
    if (res.error) {
      ctx.write(`${dim(`  editor failed: ${(res.error as Error).message} — set $EDITOR`)}${'\n'}`);
      return CmdResult.HANDLED;
    }
  } finally {
    ctx.resumeRender?.();
    ctx.resumeInput?.();
  }
  let text = '';
  try {
    text = readFileSync(file, 'utf8').replace(/\n+$/, '');
  } catch {
    text = '';
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  if (!text.trim()) {
    ctx.write(`${dim('  empty — nothing queued')}${'\n'}`);
    return CmdResult.HANDLED;
  }
  const lines = text.split('\n').length;
  if (ctx.queueText?.(text)) {
    ctx.write(`${green(icons.ok)} queued ${lines} line${lines === 1 ? '' : 's'} from editor${'\n'}`);
  } else {
    ctx.insertText?.(text);
  }
  return CmdResult.HANDLED;
}
