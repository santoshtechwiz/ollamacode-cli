import fs from 'node:fs';
import path from 'node:path';

function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = withoutExport.slice(eq + 1).trim();

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }
  return out;
}

export function loadDotEnv(dir: string = process.cwd()): string[] {
  let cur = path.resolve(dir);
  let found: string | null = null;
  for (;;) {
    const candidate = path.join(cur, '.env');
    try {
      fs.accessSync(candidate);
      found = candidate;
      break;
    } catch {}
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  if (!found) return [];
  let text;
  try {
    text = fs.readFileSync(found, 'utf8');
  } catch {
    return [];
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}

