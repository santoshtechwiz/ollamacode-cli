import fs from 'node:fs';
import path from 'node:path';

import { SESSION_ID_LENGTH, SESSION_RECORD_VERSION, STORAGE, EPHEMERAL_SESSION } from '../protocol';
import { memoryDir } from '../context/memory';
import { recoveryDir } from './session-recovery';
import { compact, trimmedCount, trimmedNote } from '../context/builder';
import { isContinueInput } from '../agent/intent';
import { checkpointPath } from './paths';
import { logger } from './logger';
import { stableStringify } from './stable-json';
import { writeJsonAtomic } from './config';
import type { PlanRecordReference } from '../protocol';

/** Token budget for the saved record; older messages are evicted and noted in its summary. Each request trims to the live window, so this only bounds disk and resume. */
const MAX_RECORD_TOKENS = 64_000;

export interface SessionRecord {
  version: number;
  id: string;
  providerId: string;
  model: string;
  toolsEnabled: boolean;
  /** Review mode was on when this session was saved; a resume must honour it. */
  reviewMode?: boolean;
  /** Ask mode was on when this session was saved; a resume must honour it. */
  askMode?: boolean;
  messages: import('../types.ts').Message[];
  /** What plan mode looked at before presenting each plan: a record for diagnosis, never replayed to the model. */
  explored?: import('../types.ts').Message[][];
  /** Subagent conversations, for diagnosis; never loaded back into the conversation. */
  subagents?: import('../agent/subagent/runner.ts').SubagentRun[];
  cwd?: string;
  /** The project folder this conversation was working in, workspace-relative, so a resume keeps "this project". */
  workedProject?: string;
  permissions?: { alwaysAllowAll: boolean; alwaysAllowTools: string[]; };
  /** Summary of exchanges trimmed out of the record's messages; owned by saveSession. */
  summary?: string;
  /** The plan this conversation was working on, stamped at the last save. */
  plan?: PlanRecordReference;
  /** Tokens this conversation sent and received, so a resume keeps counting from there. */
  usage?: { totals: import('./usage.ts').UsageTotals; turns: import('./usage.ts').TurnUsage[] };
  createdAt?: number;
  updatedAt?: number;
}

function sessionsDir(root: string) {
  return path.join(memoryDir(root), STORAGE.SESSIONS_DIR);
}

function sessionFile(root: string, id: string) {
  return path.join(sessionsDir(root), `${id}.json`);
}

export function newSessionId(): string {
  let id = '';
  while (id.length < SESSION_ID_LENGTH) {
    id += Math.random().toString(36).slice(2);
  }
  return id.slice(0, SESSION_ID_LENGTH);
}

function asRecord(parsed: unknown): SessionRecord | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const rec = (parsed as any);
  if (rec.version !== SESSION_RECORD_VERSION) return null;
  if (typeof rec.id !== 'string' || !rec.id) return null;
  if (!Array.isArray(rec.messages)) return null;
  return (rec as SessionRecord);
}

/** Ids of every record on disk; normally one, briefly two while another window holds its own. */
function recordIds(root: string): string[] {
  try {
    return fs.readdirSync(sessionsDir(root)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).filter(isPlainId);
  } catch {
    return [];
  }
}

/** Conversations a workspace keeps; saving one past this drops the oldest. */
export const MAX_SESSIONS = 10;

/** This workspace's conversations, newest first; records nobody typed into are left out. */
export function listSessions(root: string): SessionRecord[] {
  return recordIds(root)
    .map((id) => readSession(root, id))
    .filter((rec): rec is SessionRecord => Boolean(rec && rec.messages.length > 0))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** A conversation named by the first thing the person asked in it. */
export function sessionTitle(rec: SessionRecord, max = 60): string {
  const first = rec.messages.find((m) => m.role === 'user' && !String(m.content ?? '').startsWith('['));
  const text = String(first?.content ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text || '(no question)';
}

/** The conversation this workspace continues by default: the most recently saved record that has a conversation in it. */
export function lastSession(root: string): SessionRecord | null {
  let newest: SessionRecord | null = null;
  for (const id of recordIds(root)) {
    const rec = readSession(root, id);
    if (rec && rec.messages.length > 0 && (!newest || (rec.updatedAt ?? 0) > (newest.updatedAt ?? 0))) newest = rec;
  }
  return newest;
}

export function readSession(root: string, id: string): SessionRecord | null {
  if (!isPlainId(id)) return null;
  try {
    return asRecord(JSON.parse(fs.readFileSync(sessionFile(root, id), 'utf-8')));
  } catch {
    return null;
  }
}

export function saveSession(rec: SessionRecord, root: string): SessionRecord {
  const now = Date.now();
  // An ephemeral session has no durable conversation: it is never written, so it can never replace the project's last one.
  if (rec.id === EPHEMERAL_SESSION) return { ...rec, version: SESSION_RECORD_VERSION, updatedAt: now };
  const existing = readSession(root, rec.id);
  const merged = mergeMessages(existing?.messages, rec.messages);
  const { messages, summary } = boundRecord(merged, rec.summary ?? existing?.summary);
  const full = {
    ...rec,
    version: SESSION_RECORD_VERSION,
    messages,
    summary,
    createdAt: existing?.createdAt ?? rec.createdAt ?? now,
    updatedAt: now,
  };
  writeJsonAtomic(sessionFile(root, rec.id), full);
  // A session nobody has typed into yet replaces nothing: quitting it, or cancelling the start choice, keeps the last conversation.
  if (messages.length > 0) pruneSessions(root, rec.id);
  return full;
}

/** Bound the saved record to the token budget; the summary counts everything evicted so far, not only this save's share. */
function boundRecord(all: import('../types.ts').Message[], previous: string | undefined): { messages: import('../types.ts').Message[]; summary?: string; } {
  const { messages, dropped } = compact(all, new Set(), MAX_RECORD_TOKENS);
  if (!dropped) return { messages, summary: previous };
  return { messages, summary: trimmedNote(trimmedCount(previous) + dropped) };
}

/** A stable key for a message: its `id` when stamped, else a hash of its content. */
function messageIdentity(m: import('../types.ts').Message | undefined): string {
  if (typeof m?.id === 'string' && m.id) return `id:${m.id}`;
  return `h:${stableStringify([m?.role, m?.tool_call_id, m?.name, m?.content])}`;
}

/** Merge, never overwrite: keep what is on disk, upgrade shared messages, append new ones, so concurrent writers never lose turns. */
function mergeMessages(disk: import('../types.ts').Message[] | undefined, incoming: import('../types.ts').Message[] | undefined): import('../types.ts').Message[] {
  const seen = new Set<string>();
  const out: import('../types.ts').Message[] = [];
  const pushUnique = (m: import('../types.ts').Message) => {
    // Bare "continue" tokens are control signals, not conversation, so they are dropped wherever they appear.
    if (m?.role === 'user' && typeof m?.content === 'string' && isContinueInput(m.content)) return;
    const key = messageIdentity(m);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };
  for (const m of disk ?? []) pushUnique(m);
  // Incoming messages older than the first one still on disk were trimmed into the summary; re-adding them would append the past at the end.
  const list = incoming ?? [];
  const overlap = list.findIndex((m) => seen.has(messageIdentity(m)));
  for (const m of overlap > 0 ? list.slice(overlap) : list) pushUnique(m);
  return out;
}

const CLAIM_STALE_MS = 24 * 60 * 60 * 1000;

export interface SessionClaim { pid: number; startedAt: number; }

function claimFile(root: string, id: string): string {
  return `${sessionFile(root, id)}.lock`;
}

function readClaim(root: string, id: string): SessionClaim | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(claimFile(root, id), 'utf-8'));
    if (parsed && typeof parsed === 'object' && typeof parsed.pid === 'number' && typeof parsed.startedAt === 'number') {
      return { pid: parsed.pid, startedAt: parsed.startedAt };
    }
  } catch {
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it; still alive.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/** Advisory ownership of a resumed record, so two processes do not both edit the same conversation. */
export function claimSession(root: string, id: string): { ok: true } | { ok: false; owner: SessionClaim } {
  const file = claimFile(root, id);
  // The claim can be the first thing ever written to a workspace.
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    // A claim is advisory. If the directory cannot be made, the open below
    // fails and the caller carries on unclaimed rather than not running.
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return { ok: true };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'EEXIST') {
        // Somebody holds it; fall through to the staleness check below.
      } else {
        // Anything else (a read-only workspace, a path that cannot be made) means this process cannot take an advisory lock.
        logger.debug(`could not claim session ${id}: ${(err as Error).message}`);
        return { ok: false, owner: { pid: process.pid, startedAt: Date.now() } };
      }
    }
    const claim = readClaim(root, id);
    const stale = !claim || !pidAlive(claim.pid) || Date.now() - claim.startedAt > CLAIM_STALE_MS;
    if (stale) {
      try {
        fs.unlinkSync(file);
      } catch {
      }
      continue;
    }
    return { ok: false, owner: claim };
  }
  return { ok: false, owner: { pid: process.pid, startedAt: Date.now() } };
}

export function releaseSessionClaim(root: string, id: string) {
  const claim = readClaim(root, id);
  if (claim && claim.pid === process.pid) {
    try {
      fs.unlinkSync(claimFile(root, id));
    } catch {
    }
  }
}

/** Remove a conversation and everything keyed to it; `/clear` drops it now, not at the new session's first message. */
export function deleteSession(root: string, id: string): boolean {
  if (!isPlainId(id)) return false;
  let removed = false;
  try {
    fs.unlinkSync(sessionFile(root, id));
    removed = true;
  } catch {
    // Already gone; still sweep the state that belonged to it.
  }
  // Best-effort and individually guarded: a conversation that is gone from the list must not come back because one of its side files resisted deletion.
  try {
    fs.rmSync(recoveryDir(root, id), { recursive: true, force: true });
  } catch {
  }
  try {
    fs.rmSync(checkpointPath(root, id), { force: true });
  } catch {
  }
  try {
    fs.unlinkSync(claimFile(root, id));
  } catch {
  }
  return removed;
}

// The newest MAX_SESSIONS conversations stay, the one just saved always among them; older ones and records nobody typed
// into go, except one a second live window still holds.
function pruneSessions(root: string, id: string): void {
  const kept = new Set([id, ...listSessions(root).filter((rec) => rec.id !== id).slice(0, MAX_SESSIONS - 1).map((rec) => rec.id)]);
  for (const other of recordIds(root)) {
    if (!kept.has(other) && !heldByAnotherProcess(root, other)) deleteSession(root, other);
  }
}

function heldByAnotherProcess(root: string, id: string): boolean {
  const claim = readClaim(root, id);
  return Boolean(claim && claim.pid !== process.pid && pidAlive(claim.pid) && Date.now() - claim.startedAt <= CLAIM_STALE_MS);
}

function isPlainId(id: unknown) {
  return typeof id === 'string' && /^[a-z0-9]{1,32}$/.test(id);
}

