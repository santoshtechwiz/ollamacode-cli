// A command that stops a program by name stops every process of it, ocode's own included: ocode runs on node, and
// under a shell and a terminal. Such a command is read off before it runs, the way a delete's targets are.

import path from 'node:path';
import { TOOL_ERROR_CODE } from '../../../protocol';
import { fail } from '../../core/tool-result';
import { lineageOf, listProcesses } from '../processes/discovery';

/** Commands that stop every process of a program named on them; the capture is the name (or a comma list). */
const KILL_BY_NAME: readonly RegExp[] = [
  // PowerShell: Stop-Process -Name node, spps -ProcessName node,npm, kill -Name node
  /\b(?:Stop-Process|spps|kill)\b[^\n|;&]*?-(?:Process)?Name\s+([^\s;|&]+(?:\s*,\s*[^\s;|&]+)*)/gi,
  // PowerShell: Get-Process node | Stop-Process
  /\b(?:Get-Process|gps|ps)\s+(?:-(?:Process)?Name\s+)?([^\s;|&-][^\s;|&]*)[^\n;&|]*\|\s*(?:Stop-Process|spps|kill)\b/gi,
  // Windows: taskkill /F /IM node.exe
  /\btaskkill\b[^\n;&|]*?\/IM\s+([^\s;&|]+)/gi,
  // POSIX: pkill node, pkill -f node, killall node
  /\b(?:pkill|killall)\b(?:\s+-[A-Za-z0-9]+)*\s+([^\s;&|-][^\s;&|]*)/gi,
];

/** A program name as a command or the OS gives it: no quotes, no `.exe`, lower case. */
function programName(raw: string): string {
  return String(raw ?? '').trim().replace(/^["']+|["']+$/g, '').replace(/\.exe$/i, '').toLowerCase();
}

/** The program names a command stops by name; empty when it stops none that way. */
export function namesKilledBy(command: string): string[] {
  const names: string[] = [];
  for (const re of KILL_BY_NAME) {
    for (const m of String(command ?? '').matchAll(re)) {
      for (const part of m[1].split(',')) {
        const name = programName(part);
        if (name) names.push(name);
      }
    }
  }
  return names;
}

/** A name pattern (`node`, `node*`) as a test against a program name. */
function matcher(pattern: string): (name: string) => boolean {
  const re = new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i');
  return (name) => re.test(name);
}

/** ocode's own process and every process it runs under (shell, terminal), by program name. */
async function ownPrograms(): Promise<Array<{ name: string; pid: number }>> {
  const own = [{ name: programName(path.basename(process.execPath)), pid: process.pid }];
  const processes = await listProcesses();
  const lineage = lineageOf(process.pid, processes);
  for (const p of processes) {
    if (lineage.has(p.pid) && p.pid !== process.pid) own.push({ name: programName(p.image), pid: p.pid });
  }
  return own;
}

/** The process of ocode's own a command would stop by name, or null when it stops none of them. */
export async function ownProcessStoppedBy(command: string): Promise<{ name: string; pid: number } | null> {
  const names = namesKilledBy(command);
  if (names.length === 0) return null;
  const own = await ownPrograms();
  for (const pattern of names) {
    const hit = own.find((p) => matcher(pattern)(p.name));
    if (hit) return hit;
  }
  return null;
}

/** The refusal for a command that would stop ocode itself. */
export function ownProcessRefusal(hit: { name: string; pid: number }): ReturnType<typeof fail> {
  const self = hit.pid === process.pid;
  return fail(
    `Not run: it stops every "${hit.name}" process by name, and ${self ? 'this agent itself runs' : 'this agent runs under'} ` +
      `"${hit.name}" (pid ${hit.pid}), so it would end this session.`,
    {
      code: TOOL_ERROR_CODE.EDENIED,
      hint:
        'Stop only the process you started: stop_subprocess {"id": …} for a start_subprocess job, or stop_process with its ' +
        'port or pid. Start a server with start_subprocess so it can be stopped on its own.',
    },
  );
}
