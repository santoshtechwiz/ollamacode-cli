import { parseArgs as parseWithCitty } from 'citty';
import { CLI_ARGS_DEF } from './citty-def';
import { isThinkingMode } from '../protocol';

const SHORT_TO_LONG: Record<string, string> = {
  c: 'continue',
  h: 'help',
  y: 'yes',
};

const KNOWN = new Set(Object.keys(CLI_ARGS_DEF));

const VALUE_FLAGS = new Set(
  Object.entries(CLI_ARGS_DEF)
    .filter(([, def]) => def.type === 'string')
    .map(([name]) => name)
);

const SHORT_RE = /^-[A-Za-z]+$/;

function toKebab(value: string): string {
  return value.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
  positionals: string[];
  /** Options not in CLI_ARGS_DEF, as typed ("-s", "--sesion"); the caller refuses them rather than silently ignoring them. */
  unknown: string[];
}

/** Parse argv against the schema in citty-def.ts, keeping the legacy semantics pinned by test/args.test.js. */
export function parseArgs(argv: string[]): ParsedArgs {
  let onlyPositionals = false;
  const positionalIdx: number[] = [];
  const quarantined = new Set<number>();
  const unknownPairs: Array<{ name: string; value: string }> = [];
  const unknown: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (onlyPositionals) {
      positionalIdx.push(i);
      continue;
    }
    if (arg === '--') {
      onlyPositionals = true;
      continue;
    }

    if (SHORT_RE.test(arg) && !arg.startsWith('--')) {
      const letters = arg.slice(1);
      const long = letters.length === 1 ? SHORT_TO_LONG[letters] : undefined;
      // Bundled switches (-cy) are -c -y; citty splits them, so they only need to be known and take no value.
      if (letters.length > 1 && [...letters].every((l) => SHORT_TO_LONG[l] && !VALUE_FLAGS.has(SHORT_TO_LONG[l]))) continue;
      if (long !== undefined) {
        if (VALUE_FLAGS.has(long)) {
          const value = argv[i + 1];
          if (value === undefined || value.startsWith('-')) {
            throw new Error(`Flag -${letters} (--${long}) requires a value`);
          }
          i += 1;
        }
        continue;
      }
      unknown.push(arg);
      quarantined.add(i);
      positionalIdx.push(i);
      continue;
    }

    if (!arg.startsWith('--')) {
      positionalIdx.push(i);
      continue;
    }

    const body = arg.slice(2);
    const name = body.split('=')[0].replace(/^no-/, '');
    if (!KNOWN.has(name)) unknown.push(`--${body.split('=')[0]}`);
    if (body.includes('=')) continue;
    if (body.startsWith('no-')) continue;

    if (KNOWN.has(body)) {
      if (VALUE_FLAGS.has(body)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
          throw new Error(`Flag --${body} requires a value`);
        }
        i += 1;
      } else if (body === 'think') {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--') && isThinkingMode(next)) {
          i += 1;
        }
      }
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      unknownPairs.push({ name: body, value: next });
      i += 1;
    }
  }

  const sanitized = argv.filter((_, i) => !quarantined.has(i));
  const parsed = parseWithCitty(sanitized, CLI_ARGS_DEF) as Record<string, unknown>;

  const flags: Record<string, string | boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === '_') continue;
    if (value === undefined) continue;
    if (key.length === 1) continue;
    if (key !== toKebab(key) && KNOWN.has(toKebab(key))) continue;
    if (typeof value === 'string' || typeof value === 'boolean') {
      flags[key] = value;
    }
  }

  for (const { name, value } of unknownPairs) {
    flags[name] = value;
  }

  applyThinkValue(argv, flags);

  return { flags, positionals: positionalIdx.map((i) => argv[i]), unknown };
}

/** Citty sees `think` as a pure boolean so it never swallows the following word; the value forms are restored here from the raw tokens. */
function applyThinkValue(argv: string[], flags: Record<string, string | boolean>): void {
  let found = false;
  let value: string | boolean = true;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') break;
    if (!arg.startsWith('--')) continue;
    const body = arg.slice(2);
    if (body === 'think') {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && isThinkingMode(next)) {
        found = true;
        value = next;
      } else {
        found = true;
        value = true;
      }
      continue;
    }
    if (body.startsWith('think=')) {
      const raw = body.slice('think='.length);
      found = true;
      value = raw === 'true' ? true : raw === 'false' ? false : raw;
    }
  }

  if (found) flags.think = value;
}
