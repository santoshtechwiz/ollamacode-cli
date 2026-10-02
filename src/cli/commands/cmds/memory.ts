import { bold, cyan, dim, green, icons, red, yellow } from '../../../ui/ansi';
import { forgetEntry, loadMemory, summarizeMemory, updateMemory } from '../../../context/memory';
import { CmdResult } from './types';

export async function runMemory(ctx: any, arg: string): Promise<boolean | 'exit'> {
  const root = ctx.workspace.state.root;
  const [sub, ...rest] = arg.split(/\s+/).filter(Boolean);
  try {
    if (!sub || sub === 'list' || sub === 'show') {
      const mem = loadMemory(root);
      const rows = [
        ...mem.conventions.map((c, i) => `${dim(`${i + 1}.`)} ${green('[conv]')} ${c}`),
        ...mem.facts.map((f, i) => `${dim(`${mem.conventions.length + i + 1}.`)} ${cyan('[fact]')} ${f.text}`),
      ];
      ctx.write(
        `  ${bold('memory')}${dim(` — facts & session state, ${summarizeMemory(mem)} (OLLAMACODE.md is the project doc — /init writes it)`)}\n` +
          (rows.length ? `  ${rows.join('\n  ')}\n` : `  ${dim('(empty)')}\n`) +
          `${dim('  add: /memory add <text>   forget: /memory forget <n>')}\n`
      );
    } else if (sub === 'add' || sub === 'remember') {
      const text = rest.join(' ').trim();
      if (!text) {
        ctx.write(`${yellow('  usage: /memory add <text>')}\n`);
      } else {
        updateMemory(root, (m) => {
          m.conventions.push(text);
        });
        ctx.write(`${green(icons.ok)} remembered${dim(' — injected into every future session here')}\n`);
      }
    } else if (sub === 'forget' || sub === 'remove' || sub === 'rm') {
      let kind = (null as string | null);
      updateMemory(root, (m) => {
        kind = forgetEntry(m, Number(rest[0]));
      });
      if (kind) ctx.write(`${green(icons.ok)} removed ${kind} ${rest[0]}\n`);
      else ctx.write(`${red(`  no entry ${rest[0] ?? ''} — /memory to list`)}\n`);
    } else {
      ctx.write(`${dim('  usage: /memory [list|add <text>|forget <n>]')}\n`);
    }
  } catch (err) {
    ctx.write(`${red(`  memory unavailable: ${(err as Error).message}`)}\n`);
  }
  return CmdResult.HANDLED;
}
