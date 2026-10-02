import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ProcessInfo } from './attribution';

export type { Attribution, ProcessInfo } from './attribution';
export { isProtectedPid } from './attribution';

/** Process discovery via OS queries (netstat/ss/lsof, tasklist/ps). */

const execFileAsync = promisify(execFile);

function netstatListeningPids(text: string, port: number): number[] {
  const out: number[] = [];
  for (const line of String(text ?? '').split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4) continue;
    if (!/^tcp/i.test(cols[0] ?? '')) continue;
    if (!/listening/i.test(cols[3] ?? '')) continue;
    const local = cols[1] ?? '';
    if (!local.endsWith(`:${port}`)) continue;
    const pid = Number(cols[cols.length - 1]);
    if (Number.isInteger(pid) && pid > 0 && !out.includes(pid)) out.push(pid);
  }
  return out;
}

function ssListeningPids(text: string, port: number): number[] {
  const out: number[] = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!/\blisten\b/i.test(line)) continue;
    if (!new RegExp(`:${port}\\b`).test(line)) continue;
    for (const m of line.matchAll(/pid=(\d+)/g)) {
      const pid = Number(m[1]);
      if (Number.isInteger(pid) && pid > 0 && !out.includes(pid)) out.push(pid);
    }
  }
  return out;
}

export async function listeningPids(port: number): Promise<number[]> {
  if (process.platform === 'win32') {
    const { stdout } = await execFileAsync('netstat', ['-ano']);
    return netstatListeningPids(stdout, port);
  }
  try {
    const { stdout } = await execFileAsync('ss', ['-ltnp']);
    return ssListeningPids(stdout, port);
  } catch {
    const { stdout } = await execFileAsync('lsof', [`-iTCP:${port}`, '-sTCP:LISTEN', '-t']);
    return String(stdout ?? '')
      .split('\n')
      .map((l) => Number(l.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
  }
}

export async function describeProcess(pid: number): Promise<{ image: string; command: string; exePath?: string; } | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      const first = String(stdout ?? '').split('\n').find((l) => l.includes(`"${pid}"`));
      if (!first) return null;
      const image = (first.match(/^"([^"]+)"/) ?? [])[1] ?? `PID ${pid}`;
      const detailed = await describeWindowsProcess(pid);
      return { image, command: detailed?.command ?? '', exePath: detailed?.exePath };
    }
    const { stdout } = await execFileAsync('ps', ['-o', 'comm=', '-p', String(pid)]);
    const image = String(stdout ?? '').trim();
    if (!image) return null;
    let command = '';
    try {
      const full = await execFileAsync('ps', ['-o', 'args=', '-p', String(pid)]);
      command = String(full.stdout ?? '').trim().slice(0, 160);
    } catch {
    }
    return { image, command };
  } catch {
    return null;
  }
}

/** Best-effort Windows command-line + executable path for one PID. */
async function describeWindowsProcess(pid: number): Promise<{ command: string; exePath?: string; } | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine; @(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty ExecutablePath)`,
      ],
      { timeout: 8000 } as { timeout: number },
    );
    const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;
    const exePath = lines.length > 1 ? lines[lines.length - 1] : undefined;
    const command = (exePath && lines.length > 1 ? lines.slice(0, -1) : lines).join(' ').slice(0, 512);
    return { command, exePath: exePath && /[\\/]/.test(exePath) ? exePath : undefined };
  } catch {
    return null;
  }
}

/** Every visible process, best-effort. */
export async function listProcesses(): Promise<ProcessInfo[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.Name)`t$($_.ExecutablePath)`t$($_.CommandLine)" }',
        ],
        { timeout: 15000 } as { timeout: number },
      );
      const out: ProcessInfo[] = [];
      for (const line of String(stdout ?? '').split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const pid = Number((parts[0] ?? '').trim());
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const parentPid = Number((parts[1] ?? '').trim());
        out.push({
          pid,
          ...(Number.isInteger(parentPid) && parentPid > 0 ? { parentPid } : {}),
          image: (parts[2] ?? '').trim() || `PID ${pid}`,
          exePath: (parts[3] ?? '').trim() || undefined,
          command: (parts.slice(4).join('\t') ?? '').trim().slice(0, 512),
        });
      }
      return out;
    }
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid,ppid,comm,args']);
    const out: ProcessInfo[] = [];
    for (const line of String(stdout ?? '').split('\n').slice(1)) {
      const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
      if (!m) continue;
      const pid = Number(m[1]);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      const parentPid = Number(m[2]);
      out.push({
        pid,
        ...(parentPid > 0 ? { parentPid } : {}),
        image: m[3] ?? `PID ${pid}`,
        command: (m[4] ?? '').slice(0, 512),
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** The pid and every process above it, as far as the list knows them. */
export function lineageOf(pid: number, processes: readonly ProcessInfo[]): Set<number> {
  const parentOf = new Map(processes.map((p) => [p.pid, p.parentPid]));
  const lineage = new Set<number>();
  for (let at: number | undefined = pid; at && !lineage.has(at); at = parentOf.get(at)) lineage.add(at);
  return lineage;
}
