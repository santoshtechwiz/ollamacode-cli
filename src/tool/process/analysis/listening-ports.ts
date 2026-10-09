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

/**
 * Windows: one PowerShell call lists both, as `P <pid> <parent>` and `L <pid> <port>` lines. Get-NetTCPConnection
 * reads the same on every Windows language (netstat prints LISTENING in the system's language), and the script goes in
 * as -EncodedCommand so no quoting rule between Node and PowerShell can change it.
 */
const WINDOWS_SCRIPT = [
  'Get-CimInstance Win32_Process | ForEach-Object { "P $($_.ProcessId) $($_.ParentProcessId)" }',
  'Get-NetTCPConnection -State Listen | ForEach-Object { "L $($_.OwningProcess) $($_.LocalPort)" }',
].join('; ');

/** The `P`/`L` listing above. */
export function parseWindowsListing(text: string): { table: ProcessTable; listeners: Listener[] } {
  const table: ProcessTable = new Map();
  const listeners: Listener[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^([PL]) (\d+) (\d+)\s*$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'P') table.set(Number(m[2]), Number(m[3]));
    else listeners.push({ pid: Number(m[2]), port: Number(m[3]) });
  }
  return { table, listeners };
}

async function windowsListing(): Promise<{ table: ProcessTable; listeners: Listener[] } | null> {
  const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
  const text = await run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  if (text === null) return null;
  const listing = parseWindowsListing(text);
  // No process at all means the listing did not run, not that nothing listens.
  return listing.table.size > 0 ? listing : null;
}

/** Elsewhere: the first of ss and lsof that answers, and ps for the process tree. */
const LISTENER_QUERIES: ReadonlyArray<{ file: string; args: string[]; parse: (text: string) => Listener[] }> = [
  { file: 'ss', args: ['-ltnpH'], parse: parseSs },
  { file: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], parse: parseLsof },
];

async function unixListing(): Promise<{ table: ProcessTable; listeners: Listener[] } | null> {
  let listeners: Listener[] | null = null;
  for (const query of LISTENER_QUERIES) {
    const text = await run(query.file, query.args);
    if (text !== null) {
      listeners = query.parse(text);
      break;
    }
  }
  if (listeners === null) return null;
  const ps = await run('ps', ['-A', '-o', 'pid=,ppid=']);
  const table = ps === null ? null : parseProcessTable(ps);
  return table && table.size > 0 ? { table, listeners } : null;
}

/**
 * The ports the process tree under `pid` listens on, sorted. null when the system could not be asked, or only part of
 * it answered: without the whole process tree a server's port (held by a grandchild) would read as "not listening",
 * so nothing is said rather than something false.
 */
export async function listeningPorts(pid: number | undefined): Promise<number[] | null> {
  if (!pid) return null;
  const listing = process.platform === 'win32' ? await windowsListing() : await unixListing();
  if (!listing) return null;
  const tree = processTree(pid, listing.table);
  return [...new Set(listing.listeners.filter((l) => tree.has(l.pid)).map((l) => l.port))].sort((a, b) => a - b);
}

/** What a person or model reads about where a running job can be reached. */
export function describeListening(ports: number[] | null): string | null {
  if (ports === null) return null;
  if (ports.length === 0) return 'Not listening on any port yet: it is still starting, or it is not a server.';
  return `Listening on ${ports.map((p) => `http://localhost:${p}`).join(', ')}`;
}
