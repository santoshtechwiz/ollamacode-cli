import fsp from 'node:fs/promises';
import path from 'node:path';

import { EPHEMERAL_SESSION } from '../protocol';
import { resolveDeleteTargets } from '../tool/policy/mutation-policy';


const MAX_ENTRIES = 5000;

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;

/** A shell delete is snapshotted whole; this bounds one command so it cannot fill the disk. */
const MAX_SHELL_SNAPSHOT_FILES = 5000;

/**
 * What the whole pre-image store may hold.
 *
 * A per-file cap alone still allows 5000 × 5 MB — 25 GB of copies made on the user's behalf to
 * protect their work. Past this, files are reported as unrestorable rather than copied, which is
 * the same honest answer the per-file cap already gives.
 */
const MAX_TOTAL_SNAPSHOT_BYTES = 256 * 1024 * 1024;

const RECOVERY_DIR = '.ollamacode';


function noLedger(sessionId: string | undefined): sessionId is undefined {
  return !sessionId || sessionId === EPHEMERAL_SESSION;
}


export function sessionHasLedger(sessionId: string | undefined): sessionId is string {
  return !noLedger(sessionId);
}

interface RecoveryEntry {
  seq: number;
  tool: string;
  rel: string;
  existed: boolean;
  at: number;
  /** Files saved by one call share a group, so a bulk delete is undone in one go. */
  group?: string;
}

export interface PendingRecovery {
  seq: number;
  tool: string;
  rel: string;
  existed: boolean;
  /** Staged byte file, present only when the target existed before the call. */
  bin: string | null;
  group?: string;
}

interface UndoOutcome {
  entry: RecoveryEntry;
  action: 'restored' | 'removed';
  /** Every path put back, when one call's files were undone together. */
  paths?: string[];
}

export function recoveryDir(root: string, sessionId: string): string {
  return path.join(path.resolve(root), RECOVERY_DIR, 'recovery', sessionId);
}

function ledgerPath(root: string, sessionId: string): string {
  return path.join(recoveryDir(root, sessionId), 'ledger.json');
}

function binPath(root: string, sessionId: string, seq: number): string {
  return path.join(recoveryDir(root, sessionId), `${seq}.bin`);
}

/** Is this workspace-relative path inside the recovery store or git internals? */
function excluded(rel: string): boolean {
  const head = rel.split('/')[0];
  return head === RECOVERY_DIR || head === '.git' || rel === '.';
}

function insideRoot(root: string, abs: string): boolean {
  const base = path.resolve(root);
  const resolved = path.resolve(abs);
  return resolved === base || resolved.startsWith(base + path.sep);
}

export async function readRecovery(root: string, sessionId: string): Promise<RecoveryEntry[]> {
  if (noLedger(sessionId)) return [];
  try {
    const raw = await fsp.readFile(ledgerPath(root, sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isEntry) : [];
  } catch {
    return [];
  }
}

function isEntry(value: unknown): value is RecoveryEntry {
  const e = value as RecoveryEntry;
  return Boolean(e) && typeof e.seq === 'number' && typeof e.rel === 'string';
}

async function writeLedger(root: string, sessionId: string, entries: RecoveryEntry[]): Promise<void> {
  const dir = recoveryDir(root, sessionId);
  await fsp.mkdir(dir, { recursive: true });
  const target = ledgerPath(root, sessionId);
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(entries, null, 2));
  await fsp.rename(tmp, target);
}


export async function stageRecovery(opts: {
  root: string;
  sessionId: string;
  tool: string;
  abs: string;
  rel: string;
  group?: string;
}): Promise<PendingRecovery | null> {
  const { root, sessionId, tool, abs, rel } = opts;
  if (noLedger(sessionId) || excluded(rel) || !insideRoot(root, abs)) return null;

  const st = await fsp.lstat(abs).catch((): null => null);
  if (st?.isDirectory() || st?.isSymbolicLink()) return null;

  const existed = Boolean(st?.isFile());
  if (existed && (st?.size ?? 0) > MAX_SNAPSHOT_BYTES) return null;


  const dir = recoveryDir(root, sessionId);
  let maxSeq = 0;
  try {
    const entries = await fsp.readdir(dir);
    for (const name of entries) {
      const n = Number(name.slice(0, name.lastIndexOf('.')));
      if (Number.isInteger(n) && n > 0) maxSeq = Math.max(maxSeq, n);
    }
  } catch {
    // Directory does not exist yet — no staged or committed bins.
  }
  const ledger = await readRecovery(root, sessionId);
  const seq = Math.max(maxSeq, ledger.reduce((max, e) => Math.max(max, e.seq), 0), 0) + 1;

  let bin: string | null = null;
  if (existed) {
    await fsp.mkdir(dir, { recursive: true });
    bin = binPath(root, sessionId, seq);
    await fsp.copyFile(abs, bin);
  }
  return { seq, tool, rel, existed, bin, group: opts.group };
}

/** Record a successful restorable call in the session ledger. */
export async function commitRecovery(
  opts: { root: string; sessionId: string },
  pending: PendingRecovery | null
): Promise<void> {
  if (!pending) return;
  const { root, sessionId } = opts;
  const ledger = await readRecovery(root, sessionId);
  ledger.push({ seq: pending.seq, tool: pending.tool, rel: pending.rel, existed: pending.existed, at: Date.now(), group: pending.group });
  while (ledger.length > MAX_ENTRIES) {
    const old = ledger.shift();
    if (old?.existed) await fsp.rm(binPath(root, sessionId, old.seq), { force: true }).catch(() => {});
  }
  await writeLedger(root, sessionId, ledger);
}

/** Drop a staged pre-image for a call that failed and changed nothing. */
export async function discardRecovery(pending: PendingRecovery | null): Promise<void> {
  if (!pending?.bin) return;
  await fsp.rm(pending.bin, { force: true }).catch(() => {});
}

/**
 * A shell delete has no pre-image, so `undo` used to be able to say nothing and the work was gone
 * for good. Copy every file the command is about to remove into the ledger first, so the same
 * `undo` that restores an edited file also brings a deleted project back.
 */
export async function snapshotShellDeletes(opts: {
  root: string;
  sessionId: string | undefined;
  tool: string;
  command: string;
}): Promise<{ snapshotted: number; unrestorable: number; group?: string }> {
  const { root, sessionId, tool, command } = opts;
  const empty = { snapshotted: 0, unrestorable: 0, group: undefined };
  if (noLedger(sessionId)) return empty;
  // Wildcards and chained deletes resolve here, before the shell gets to them; a delete that
  // cannot be enumerated is refused upstream, so an opaque result here copies nothing.
  const { paths: targets, opaque } = resolveDeleteTargets(command, root);
  if (opaque || targets.length === 0) return empty;
  return snapshotPaths({ root, sessionId, tool, targets });
}

/**
 * Copies every file under the given paths (files, or folders walked whole) into the ledger before they are deleted,
 * so `undo` brings them back. Shared by shell deletes and delete_file's recursive folder delete.
 */
/**
 * A folder delete is saved for /undo file by file; past this many files (a node_modules, a build output) copying
 * them first takes minutes, so the folder is deleted in one go and the question says /undo cannot bring it back.
 */
export const FOLDER_UNDO_MAX_FILES = 1000;

/** Whether the folder holds more than `limit` files; stops counting as soon as it does. */
export async function hasMoreFilesThan(dir: string, limit: number): Promise<boolean> {
  let count = 0;
  const stack = [dir];
  while (stack.length > 0) {
    // The folder read is kept: Dirent.parentPath is missing on the Node 18 and 20 releases engines still allows.
    const current = stack.pop() as string;
    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(path.join(current, entry.name));
      else if (entry.isFile() && ++count > limit) return true;
    }
  }
  return false;
}

export async function snapshotPaths(opts: {
  root: string;
  sessionId: string | undefined;
  tool: string;
  targets: string[];
}): Promise<{ snapshotted: number; unrestorable: number; group?: string }> {
  const { root, sessionId, tool, targets } = opts;
  const empty = { snapshotted: 0, unrestorable: 0, group: undefined };
  if (noLedger(sessionId)) return empty;

  const files: string[] = [];
  for (const abs of targets) {
    if (!insideRoot(root, abs) || abs === path.resolve(root)) continue;
    const st = await fsp.lstat(abs).catch((): null => null);
    if (!st) continue;
    if (st.isSymbolicLink()) continue;
    if (!st.isDirectory()) {
      files.push(abs);
      continue;
    }
    const stack = [abs];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const child = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (excluded(path.relative(root, child).split(path.sep).join('/'))) continue;
          stack.push(child);
        } else if (entry.isFile()) {
          files.push(child);
        }
      }
    }
  }
  if (files.length === 0) return empty;

  let snapshotted = 0;
  let unrestorable = 0;
  let budget = MAX_TOTAL_SNAPSHOT_BYTES - await storedBytes(root, sessionId);
  const group = `g${Date.now().toString(36)}`;
  for (const abs of files.slice(0, MAX_SHELL_SNAPSHOT_FILES)) {
    const size = await fileSize(abs);
    if (size === null || size > budget) {
      // No room left in the store: the file still gets deleted, and saying so is the only honest
      // answer left. `undo` will not bring this one back.
      unrestorable += 1;
      continue;
    }
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const pending = await stageRecovery({ root, sessionId, tool, abs, rel, group });
    if (!pending) {
      unrestorable += 1;
      continue;
    }
    await commitRecovery({ root, sessionId }, pending);
    budget -= size;
    snapshotted += 1;
  }
  if (files.length > MAX_SHELL_SNAPSHOT_FILES) unrestorable += files.length - MAX_SHELL_SNAPSHOT_FILES;
  return { snapshotted, unrestorable, group: snapshotted > 0 ? group : undefined };
}

/** What the pre-image store already holds, so a new snapshot cannot quietly double the disk use. */
async function storedBytes(root: string, sessionId: string): Promise<number> {
  try {
    const entries = await fsp.readdir(recoveryDir(root, sessionId));
    let total = 0;
    for (const name of entries) {
      if (!name.endsWith('.bin')) continue;
      const st = await fsp.stat(path.join(recoveryDir(root, sessionId), name)).catch((): null => null);
      total += st?.size ?? 0;
    }
    return total;
  } catch {
    return 0;
  }
}

async function fileSize(abs: string): Promise<number | null> {
  const st = await fsp.stat(abs).catch((): null => null);
  return st?.isFile() ? st.size : null;
}


export async function undoLast(root: string, sessionId: string, rel?: string): Promise<UndoOutcome | null> {
  if (noLedger(sessionId)) return null;
  const ledger = await readRecovery(root, sessionId);
  let index = -1;
  for (let i = ledger.length - 1; i >= 0; i -= 1) {
    if (rel === undefined || ledger[i].rel === rel) {
      index = i;
      break;
    }
  }
  if (index === -1) return null;

  const entry = ledger[index];
  // One shell delete saved many files: they were one action, so they undo together.
  const group = rel === undefined ? entry.group : undefined;
  const members = group ? ledger.filter((e) => e.group === group) : [entry];
  const paths: string[] = [];
  const action: 'restored' | 'removed' = entry.existed ? 'restored' : 'removed';
  for (const member of members) {
    const target = path.resolve(root, member.rel);
    if (!insideRoot(root, target) || excluded(member.rel)) continue;
    try {
      if (member.existed) {
        const bytes = await fsp.readFile(binPath(root, sessionId, member.seq));
        await fsp.mkdir(path.dirname(target), { recursive: true });
        await fsp.writeFile(target, bytes);
        paths.push(member.rel);
      } else {
        await fsp.rm(target, { force: true });
        paths.push(member.rel);
      }
    } catch {
      // A pre-image that cannot be read is reported by its absence in `paths`, not by a silent success.
      continue;
    }
  }

  const doomed = new Set(members.map((m) => m.seq));
  await writeLedger(root, sessionId, ledger.filter((e) => !doomed.has(e.seq)));
  for (const member of members) {
    if (member.existed) await fsp.rm(binPath(root, sessionId, member.seq), { force: true }).catch(() => {});
  }
  if (paths.length === 0) return null;
  return { entry, action, paths };
}
