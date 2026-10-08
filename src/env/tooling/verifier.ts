import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function readWindowsUserPath(): Promise<string | null> {
  const keys = [
    'HKCU\\Environment',
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  ];
  const parts: string[] = [];
  for (const key of keys) {
    try {
      const { stdout } = await execFileAsync('reg', ['query', key, '/v', 'Path'], {
        windowsHide: true,
        timeout: 5000,
      });
      const m = stdout.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)$/m);
      if (m?.[1]?.trim()) parts.push(m[1].trim());
    } catch {
    }
  }
  return parts.length ? parts.join(path.delimiter) : null;
}

export function applySessionPathRefresh(extraDirs: string[]): string[] {
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const seen = new Set(current.map((d) => d.toLowerCase()));
  const added: string[] = [];
  for (const dir of extraDirs) {
    const clean = String(dir ?? '').trim();
    if (!clean || seen.has(clean.toLowerCase())) continue;
    current.push(clean);
    seen.add(clean.toLowerCase());
    added.push(clean);
  }
  if (added.length) process.env.PATH = current.join(path.delimiter);
  return added;
}
