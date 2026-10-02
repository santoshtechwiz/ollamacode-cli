import { parseArgs } from './args';
import { CLI_ARGS_DEF, CLI_COMMANDS, CLI_HELP } from './citty-def';
import { out } from './output';
import { loadDotEnv } from './dotenv';
import { configureLogger, type LogLevel } from '../core/logger';
import { homeDir } from '../core/config';
import { cyan, dim } from '../ui/ansi';

export async function main(argv: string[]) {
  // A leading flag (`ocode --new`, `ocode -c`) is chat with options, not a command named "--new".
  const leadingFlag = /^-/.test(argv[0] ?? '') && !['--help', '-h'].includes(argv[0]);
  const command: string | undefined = leadingFlag ? undefined : argv[0];
  const rest = leadingFlag ? argv : argv.slice(1);
  const { flags, positionals, unknown } = parseArgs(rest);
  // An option ocode does not have is refused, not ignored: a silently dropped -s used to start a new session instead of the one asked for.
  if (unknown.length > 0) {
    const first = unknown[0];
    const guess = first.startsWith('--') ? nearest(first.slice(2), Object.keys(CLI_ARGS_DEF)) : null;
    throw new Error(
      `Unknown option ${first}.\n` +
        (guess ? `Did you mean ${cyan(`--${guess}`)}? ` : '') +
        `Run ${cyan('ocode --help')} to see the options.`
    );
  }

  let loaded = loadDotEnv(process.cwd());
  if (process.env.OLLAMA_HOST === undefined || process.env.HF_TOKEN === undefined) {
    const more = loadDotEnv(homeDir());
    if (more.length) loaded = [...loaded, ...more.map((k) => `${k} (home)`)];
  }

  // --debug selects trace: stderr keeps its summaries while the log file gets every prompt, schema and wire body.
  const log = configureLogger({
    level: flags.debug ? 'trace' : (typeof flags.log === 'string' ? (flags.log as LogLevel) : undefined),
    toFile: Boolean(flags.debug),
    homeDir: homeDir(),
  });
  if (flags.debug && log.file) {
    out.error(dim(`  debug log → ${log.file} (full prompts, including file contents)\n`));
  }
  if (loaded.length) log.debug(`loaded from .env: ${loaded.join(', ')}`);

  switch (command) {
    case 'init':
      return (await import('./commands/init.ts')).run(flags);

    case 'doctor':
      return (await import('./commands/doctor.ts')).run(flags);

    case 'chat':
    case undefined:
      return (await import('./chat/repl.ts')).run(flags);

    case 'models':
      return (await import('./commands/models.ts')).run(flags);

    case 'config':
      return (await import('./commands/config.ts')).run(flags, positionals);

    case 'memory':
      return (await import('./commands/memory.ts')).run(flags, positionals);

    case 'reindex':
      return (await import('./commands/reindex.ts')).run(flags, positionals);

    case 'mcp':
      return (await import('./commands/mcp.ts')).run(flags, positionals);

    case 'help':
    case '--help':
    case '-h':
      out.write(`${CLI_HELP}\n`);
      return;

    default: {
      const known = [...CLI_COMMANDS];
      const guess = nearest(command, known);
      throw new Error(
        `Unknown command "${command}".\n` +
          (guess
            ? `Did you mean ${cyan(`ocode ${guess}`)}?`
            : `Run ${cyan('ocode --help')} to see the commands, or ${cyan(`echo "${[command, ...positionals].join(' ')}" | ocode`)} to ask for it as a task.`)
      );
    }
  }
}

function nearest(input: string, candidates: string[]): string | null {
  const dist = (a: string, b: string) => {
    const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[b.length];
  };
  let best: string | null = null;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = dist(input.toLowerCase(), c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return bestD <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}
