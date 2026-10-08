import { readFile } from 'node:fs/promises';
import { bold, cyan, dim, green, icons, red, yellow } from '../../../ui/ansi';
import { primaryDiagnostic } from '../../../env/diagnostics/cascade';
import { createWorkspace } from '../../../agent/workspace/manager';
import { CmdResult } from './types';

export async function runDebug(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const lastOutput = ctx.lastOutput;
  const diags = lastOutput?.diagnostics ?? [];
  if (!lastOutput) {
    ctx.write(`${dim('  nothing to debug yet — run a failing command first')}\n`);
    return CmdResult.HANDLED;
  }
  const cmd = lastOutput.command ? `${yellow(`  ${lastOutput.command}`)}\n` : '';
  const exit =
    lastOutput.exitCode !== undefined
      ? lastOutput.exitCode === 0
        ? `${green(`  exit ${lastOutput.exitCode}`)}${dim(' — this command succeeded; /debug is for failures')}\n`
        : `${red(`  exit ${lastOutput.exitCode}`)}\n`
      : '';
  ctx.write(
    `\n${bold('  Debug last command')}\n` +
      (cmd ? cmd : `${dim('  last tool:')} ${dim(lastOutput.label)}\n`) +
      exit
  );
  if (diags.length > 0) {
    ctx.write(`${bold('  Diagnostics')}\n`);
    for (const d of diags.slice(0, 15)) {
      const where = d.line ? `${d.file}:${d.line}${d.column ? `:${d.column}` : ''}` : d.file;
      const sev = d.severity === 'error' || d.severity === 'failure' ? red(d.severity) : yellow(d.severity);
      ctx.write(`   ${cyan(where)} ${sev}${d.code ? ` ${dim(d.code)}` : ''}: ${d.message}\n`);
    }
    if (diags.length > 15) ctx.write(`${dim(`   … ${diags.length - 15} more`)}\n`);
    const primary = primaryDiagnostic(diags, ctx.workspace.cwd);
    if (primary?.file) {
      ctx.write(
        `\n  ${yellow(icons.warn)} failing file: ${cyan(primary.file)}${primary.line ? `:${primary.line}` : ''}\n` +
          `${dim('  → /open ')}${primary.file}${primary.line ? ` ${Math.max(1, primary.line - 5)}` : ''}${dim(' to inspect, then read_file → edit_file → re-run')}\n`
      );
    }
  } else if (lastOutput.exitCode !== undefined && lastOutput.exitCode !== 0) {
    ctx.write(`${dim('  no structured diagnostics parsed — see /show for the raw output')}\n`);
  }
  const primaryArg = arg.trim();
  if (primaryArg) {
    try {
      const abs = await createWorkspace({ root: ctx.workspace.cwd, granted: ctx.workspace.state.grantedRoots }).resolve(primaryArg);
      const content = await readFile(abs, 'utf8');
      ctx.printPaged(primaryArg, content, 1);
      ctx.lastReadFile = { path: primaryArg, lines: content.split('\n').length, fullContent: content };
    } catch (err) {
      ctx.write(`${red(`  cannot open ${primaryArg}: ${(err as Error).message}`)}\n`);
    }
  }
  return CmdResult.HANDLED;
}
