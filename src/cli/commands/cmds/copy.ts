import { readFile } from 'node:fs/promises';
import { dim, cyan, green, icons, red } from '../../../ui/ansi';
import { createWorkspace } from '../../../agent/workspace/manager';
import { copyToClipboard, clipboardHint, codeBlockAt, countCodeBlocks } from '../../../ui/clipboard';
import { CmdResult } from './types';

export async function runCopy(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const trimmed = String(arg ?? '').trim();
  const source = ctx.lastOutput?.text ?? '';
  const blocks = countCodeBlocks(source);

  // `/copy 2` — the nth fenced code block of the last answer/output.
  if (/^\d+$/.test(trimmed)) {
    const n = Number.parseInt(trimmed, 10);
    const hit = codeBlockAt(source, n);
    if (!hit) {
      ctx.write(
        trimmed && source
          ? `${dim(`  no code block ${n} — last output has ${blocks} block${blocks === 1 ? '' : 's'}${blocks ? ` (try /copy 1..${blocks})` : ''}`)}\n`
          : `${dim('  nothing to copy yet — run something first')}\n`
      );
      return CmdResult.HANDLED;
    }
    const { ok, via } = await copyToClipboard(hit.code);
    ctx.write(
      ok
        ? `${green(icons.ok)} copied code block ${n}${hit.lang ? ` (${hit.lang})` : ''} ${dim(`(${hit.code.split('\n').length} lines, via ${via})`)}\n`
        : `${red(`  clipboard unavailable — install ${clipboardHint()} (or rely on OSC52 over SSH)`)}\n`
      );
    return CmdResult.HANDLED;
  }

  let payload = source;
  let what = ctx.lastOutput?.label ?? '';
  if (trimmed) {
    try {
      const abs = await createWorkspace({ root: ctx.workspace.cwd, granted: ctx.workspace.state.grantedRoots }).resolve(trimmed);
      payload = await readFile(abs, 'utf8');
      what = trimmed;
    } catch (err) {
      ctx.write(`${red(`  cannot read ${trimmed}: ${(err as Error).message}`)}\n`);
      return CmdResult.HANDLED;
    }
  }
  if (!payload) {
    ctx.write(`${dim('  nothing to copy yet — run something first')}\n`);
    return CmdResult.HANDLED;
  }
  const { ok, via } = await copyToClipboard(payload);
  // The multiple-code-blocks tip only applies when the last output is what got copied.
  const hint = !trimmed && blocks > 1 ? ` ${dim(`·tip: /copy ${cyan('2')} copies code block 2 of ${blocks}`)}` : '';
  ctx.write(
    ok
      ? `${green(icons.ok)} copied ${what || 'last output'} ${dim(`(${payload.split('\n').length} lines, via ${via})`)}${hint}\n`
      : `${red(`  clipboard unavailable — install ${clipboardHint()}`)}\n`
  );
  return CmdResult.HANDLED;
}
