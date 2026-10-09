import { runChild } from '../../../env/process/index';

// The TCP ports a background job is listening on, read from the operating system rather than from what the job printed:
// a dev server that had printed only "> next dev" left a model to make up "port 3000 was busy, so it is on 3001".
// A job is a tree (npm → node → next's worker), so the ports of every process under it count.

const QUERY_TIMEOUT_MS = 8_000;

/** pid → parent pid. */
export type ProcessTable = Map<number, number>;

/** `ps -A -o pid=,ppid=`, or the PowerShell listing below: one "pid ppid" pair per line. */
export function parseProcessTable(text: string): ProcessTable {
  const table: ProcessTable = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

/** The process and everything started under it. */
export function processTree(root: number, table: ProcessTable): Set<number> {
  const tree = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of table) {
      if (tree.has(ppid) && !tree.has(pid)) {
        tree.add(pid);
        grew = true;
      }
    }
  }
  return tree;
}

export interface Listener {
  pid: number;
  port: number;
}

const portOf = (address: string) => Number(/:(\d+)$/.exec(address.trim())?.[1]);

/** Windows `netstat -ano`: `TCP    0.0.0.0:3001    0.0.0.0:0    LISTENING    14640`. */
export function parseNetstat(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0]?.toUpperCase() !== 'TCP' || cols[3]?.toUpperCase() !== 'LISTENING') continue;
    const port = portOf(cols[1]);
    const pid = Number(cols[4]);
    if (port && pid) out.push({ pid, port });
  }
  return out;
}

/** Linux `ss -ltnpH`: `LISTEN 0 511 *:3000 *:* users:(("next-server",pid=4242,fd=21))`. */
export function parseSs(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== 'LISTEN') continue;
    const port = portOf(cols[3] ?? '');
    for (const m of line.matchAll(/pid=(\d+)/g)) if (port) out.push({ pid: Number(m[1]), port });
  }
  return out;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn`: a `p<pid>` line, then `n<address>:<port>` lines for that process. */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = [];
  let pid = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const port = portOf(line.slice(1));
      if (port) out.push({ pid, port });
    }
  }
  return out;
}

async function run(file: string, args: string[]): Promise<string | null> {
  const outcome = await runChild({ file, args, timeoutMs: QUERY_TIMEOUT_MS }).catch(() => null);
  return outcome && !outcome.spawnError && outcome.exitCode === 0 ? outcome.stdout : null;
}

/** Each way to ask the system, in order: the first that answers is used. */
const LISTENER_QUERIES: Record<string, ReadonlyArray<{ file: string; args: string[]; parse: (text: string) => Listener[] }>> = {
  win32: [{ file: 'netstat', args: ['-ano'], parse: parseNetstat }],
  linux: [
    { file: 'ss', args: ['-ltnpH'], parse: parseSs },
    { file: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], parse: parseLsof },
  ],
  darwin: [{ file: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], parse: parseLsof }],
};

const PROCESS_QUERY = process.platform === 'win32'
  ? { file: 'powershell', args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }'] }
  : { file: 'ps', args: ['-A', '-o', 'pid=,ppid='] };

/**
 * The ports the process tree under `pid` listens on, sorted; null when this system cannot be asked (no netstat, ss or
 * lsof), so "not listening yet" is never said without having looked.
 */
export async function listeningPorts(pid: number | undefined): Promise<number[] | null> {
  if (!pid) return null;
  let listeners: Listener[] | null = null;
  for (const query of LISTENER_QUERIES[process.platform] ?? []) {
    const text = await run(query.file, query.args);
    if (text !== null) {
      listeners = query.parse(text);
      break;
    }
  }
  if (listeners === null) return null;
  const table = await run(PROCESS_QUERY.file, PROCESS_QUERY.args);
  const tree = table === null ? new Set([pid]) : processTree(pid, parseProcessTable(table));
  return [...new Set(listeners.filter((l) => tree.has(l.pid)).map((l) => l.port))].sort((a, b) => a - b);
}

/** What a person or model reads about where a running job can be reached. */
export function describeListening(ports: number[] | null): string | null {
  if (ports === null) return null;
  if (ports.length === 0) return 'Not listening on any port yet: it is still starting, or it is not a server.';
  return `Listening on ${ports.map((p) => `http://localhost:${p}`).join(', ')}`;
}
