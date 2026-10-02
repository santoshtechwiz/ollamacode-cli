import { CLI_ERROR_CODE } from '../../protocol';
import path from 'node:path';
import { detectStacks } from '../../env/tooling/detector';
import {
  conventionsFile,
  forgetEntry,
  loadMemory,
  memoryDir,
  memoryFile,
  parseConventionsFile,
  seedMemoryFromStacks,
  summarizeMemory,
  updateMemory,
} from '../../context/memory';
import { bold, dim, green, yellow, icons } from '../../ui/ansi';
import { TcError } from '../../core/errors';
import { withProgress } from '../../ui/progress';

function printEntries(root: string) {
  const mem = loadMemory(root);
  const fileConventions = parseConventionsFile(root);

  process.stdout.write(`\n${bold('  Project memory')} ${dim(`— ${summarizeMemory(mem)}`)}\n`);
  const lines: any[] = [];
  let n = 0;
  for (const c of mem.conventions) {
    n += 1;
    lines.push(`    ${dim(`${String(n).padStart(3)}.`)} [convention] ${c}`);
  }
  for (const f of mem.facts) {
    n += 1;
    lines.push(
      `    ${dim(`${String(n).padStart(3)}.`)} [fact] ${f.text}${f.source === 'agent' ? dim(' (learned)') : ''}`
    );
  }
  if (!lines.length) {
    lines.push(`    ${dim('nothing stored yet')}`);
  }
  if (fileConventions.length) {
    lines.push('');
    for (const c of fileConventions) {
      lines.push(`    ${dim('  · ')} [CONVENTIONS.md] ${c}`);
    }
  }
  process.stdout.write(`\n${lines.join('\n')}\n\n`);
}

export async function run(flags: any, rest: string[] = []) {
  const root = path.resolve(String(flags.scope || flags.root || process.cwd()));
  const args = rest.filter((a) => !a.startsWith('-'));
  const sub = (args[0] || 'show').toLowerCase();

  switch (sub) {
    case 'show': {
      printEntries(root);
      process.stdout.write(
        `${dim(`  files: ${memoryFile(root)}`)}\n` +
          `${dim(`         ${conventionsFile(root)}  (edit to teach ocode directly)`)}\n\n`
      );
      return;
    }

    case 'add': {
      const text = args.slice(1).join(' ').trim();
      if (!text) throw new TcError('Usage: ocode memory add "<convention or fact>"', { code: CLI_ERROR_CODE.EINVAL });
      updateMemory(root, (m) => {
        m.conventions.push(text);
      });
      process.stdout.write(`${green(icons.ok)} remembered: ${text}\n`);
      return;
    }

    case 'forget':
    case 'remove':
    case 'rm': {
      const n = Number(args[1]);
      if (!Number.isInteger(n) || n < 1) {
        throw new TcError('Usage: ocode memory forget <entry-number>', {
          code: CLI_ERROR_CODE.EINVAL,
          hint: 'Run "ocode memory show" first — numbering matches.',
        });
      }
      let kind = (null as string | null);
      updateMemory(root, (m) => {
        kind = forgetEntry(m, n);
      });
      if (!kind) {
        throw new TcError(`No memory entry ${n}`, { code: CLI_ERROR_CODE.ENOENT, hint: 'Run "ocode memory show" first.' });
      }
      process.stdout.write(`${yellow(icons.ok)} removed ${kind} ${n}\n`);
      return;
    }

    case 'path': {
      process.stdout.write(`${memoryDir(root)}\n`);
      return;
    }

    case 'init': {
      const stacks = await withProgress('detecting stacks', () => detectStacks(root), {
        successText: (s) =>
          s.length > 0
            ? `detected ${s.map((t) => t.label).filter(Boolean).join(', ') || `${s.length} toolchains`}`
            : 'no known toolchains detected',
      });
      const { created } = seedMemoryFromStacks(root, stacks);
      process.stdout.write(
        created
          ? `${green(icons.ok)} seeded project memory at ${dim(memoryFile(root))}\n`
          : `${dim('already initialized — enriched with detected stacks')}\n`
      );
      printEntries(root);
      return;
    }

    default:
      throw new TcError(`Unknown memory subcommand "${sub}"`, {
        code: CLI_ERROR_CODE.EINVAL,
        hint: 'Use show | add | forget | path | init.',
      });
  }
}

