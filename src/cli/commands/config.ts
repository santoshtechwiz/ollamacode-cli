import { CLI_ERROR_CODE } from '../../protocol';
import { loadConfig, updateConfig, configFile } from '../../core/config';
import { dim, green, icons } from '../../ui/ansi';
import { TcError } from '../../core/errors';

const SECRET_PATH = /(^|\.)(tokens?|api[_-]?key|secret|password)(\.|$)/i;

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

function maskValue(value: unknown): string {
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-3)} (${s.length} chars)`;
}

function maskConfig(value: unknown, path: string = ''): unknown {
  if (value === null || typeof value !== 'object') {
    return SECRET_PATH.test(path) && value ? maskValue(value) : value;
  }
  if (Array.isArray(value)) return value.map((v, i) => maskConfig(v, `${path}.${i}`));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    out[key] = SECRET_PATH.test(childPath) && child && typeof child !== 'object'
      ? maskValue(child)
      : maskConfig(child, childPath);
  }
  return out;
}

function assertSafePath(parts: string[]) {
  for (const segment of parts) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new TcError(`Refusing to write the "${segment}" key`, { code: CLI_ERROR_CODE.EINVAL });
    }
  }
}

export async function run(_flags: any, rest: string[]) {
  const args = rest.filter((a) => !a.startsWith('--'));
  const [subcommand, key, ...valueParts] = args;
  const cfg = loadConfig();

  switch (subcommand) {
    case undefined:
    case 'list':
      process.stdout.write(`${JSON.stringify(maskConfig(cfg), null, 2)}\n`);
      process.stdout.write(`${dim(`  (${configFile()})`)}\n`);
      break;

    case 'path':
      process.stdout.write(`${configFile()}\n`);
      break;

    case 'get': {
      if (!key) throw new TcError('Usage: ocode config get <key>', { code: CLI_ERROR_CODE.EINVAL });
      const parts = key.split('.');
      const value = parts.reduce((acc, k) => (acc == null ? undefined : acc[k]), (cfg as any));
      if (value === undefined) {
        process.stdout.write('(not set)\n');
        break;
      }
      const masked = SECRET_PATH.test(key) && typeof value !== 'object'
        ? maskValue(value)
        : maskConfig(value, key);
      process.stdout.write(
        `${typeof masked === 'object' ? JSON.stringify(masked, null, 2) : masked}\n`
      );
      break;
    }

    case 'set': {
      if (!key || valueParts.length === 0) {
        throw new TcError('Usage: ocode config set <key> <value>', { code: CLI_ERROR_CODE.EINVAL });
      }
      const parts = key.split('.');
      assertSafePath(parts);

      let parsed = (valueParts.join(' ') as unknown);
      try {
        parsed = JSON.parse(String(parsed));
      } catch {
      }

      updateConfig((c) => {
        let node = (c as any);
        for (let i = 0; i < parts.length - 1; i++) {
          const segment = parts[i];
          if (node[segment] === null || typeof node[segment] !== 'object') node[segment] = {};
          node = node[segment];
        }
        node[parts[parts.length - 1]] = parsed;
      });
      process.stdout.write(`  ${green(icons.ok)} ${key} updated\n`);
      break;
    }

    case 'unset':
    case 'delete': {
      if (!key) throw new TcError('Usage: ocode config unset <key>', { code: CLI_ERROR_CODE.EINVAL });
      const parts = key.split('.');
      assertSafePath(parts);
      let existed = false;
      updateConfig((c) => {
        let node = (c as any);
        for (let i = 0; i < parts.length - 1; i++) {
          node = node?.[parts[i]];
          if (node === null || typeof node !== 'object') return;
        }
        const last = parts[parts.length - 1];
        existed = node != null && Object.prototype.hasOwnProperty.call(node, last);
        delete node?.[last];
      });
      process.stdout.write(
        existed
          ? `  ${green(icons.ok)} ${key} removed\n`
          : `${dim(`  ${key} was not set`)}\n`
      );
      break;
    }

    default:
      throw new TcError(`Unknown subcommand "${subcommand}". Use list | get | set | unset | path.`, {
        code: CLI_ERROR_CODE.EINVAL,
      });
  }
}

