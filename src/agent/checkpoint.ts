import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { CHECKPOINT_VERSION, EPHEMERAL_SESSION, STORAGE } from '../protocol';
import { checkpointPath, normalizeRelPath } from '../core/paths';
import { logger } from '../core/logger';
import { homeDir, writeJsonAtomic } from '../core/config';
import { resumeNote } from '../prompts/recovery';

const MAX_COMPLETED_STEPS = 40;

/** A session's resume point lives beside its sessions/ and recovery/ records (path from core/paths.ts), so deleteSession can clean up after itself. */

/** The pre-move path: one file per workspace in the shared user-data dir, keyed by a hash of the root. */
function legacyCheckpointFile(workspaceRoot: string): string {
  const hash = crypto.createHash('sha1').update(normalizeRelPath(workspaceRoot ?? '')).digest('hex').slice(0, 16);
  return path.join(homeDir(), STORAGE.USER_DATA_DIR, STORAGE.LEGACY_CHECKPOINTS_DIR, `${hash}.json`);
}

export interface CompletedStep {
  tool: string;
  target: string;
  ok: boolean;
  at: number;
}

export interface Checkpoint {
  version: number;
  root: string;
  /** The conversation this resume point belongs to. */
  sessionId: string;
  /** The request being worked on when the turn was interrupted. */
  taskId: string;
  task: string;
  stopReason: string;
  resumable: boolean;
  completed: CompletedStep[];
  partialAnswer: string;
  pendingOutputContinuation: boolean;
  iterations: number;
  provider: string | null;
  model: string | null;
  createdAt: number;
  updatedAt: number;
}

export function emptyCheckpoint(root: string, sessionId: string = EPHEMERAL_SESSION): Checkpoint {
  const now = Date.now();
  return {
    version: CHECKPOINT_VERSION,
    root,
    sessionId,
    taskId: '',
    task: '',
    stopReason: '',
    resumable: false,
    completed: [],
    partialAnswer: '',
    pendingOutputContinuation: false,
    iterations: 0,
    provider: null,
    model: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function describeStepTarget(args: any): string {
  const a = (args ?? {} as Record<string, unknown>);
  const raw = a.path ?? a.file ?? a.command ?? a.operation ?? a.query ?? a.url ?? '';
  return String(raw).replace(/\s+/g, ' ').slice(0, 160);
}

class CheckpointStore {
  root: string;
  sessionId: string;
  file: string;

  constructor({ root, sessionId }: { root: string; sessionId: string; }) {
    this.root = root;
    this.sessionId = sessionId;
    this.file = checkpointPath(root, sessionId);
  }

  #read(file: string): Checkpoint | null {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null; // no checkpoint is the normal case
    }
    try {
      const record = JSON.parse(text);
      if (!record || record.version !== CHECKPOINT_VERSION) return null;
      // A record for a different root is about a different workspace; resuming its steps would touch the wrong files.
      if (normalizeRelPath(record.root ?? '') !== normalizeRelPath(this.root)) return null;
      record.completed = Array.isArray(record.completed) ? record.completed : [];
      return (record as Checkpoint);
    } catch (err) {
      logger.debug(`ignoring unreadable checkpoint ${file}: ${ (err as Error).message}`);
      return null;
    }
  }

  load(): Checkpoint | null {
    const own = this.#read(this.file);
    if (own) return own;
    return this.#adoptLegacy();
  }

  /** One-time upgrade. */
  #adoptLegacy(): Checkpoint | null {
    const legacy = legacyCheckpointFile(this.root);
    const record = this.#read(legacy);
    try {
      fs.rmSync(legacy, { force: true });
    } catch {
      // A checkpoint we could not delete is not worth failing a turn over.
    }
    if (!record) return null;
    logger.debug(`adopted the pre-session checkpoint at ${legacy} into session ${this.sessionId}`);
    return { ...record, sessionId: this.sessionId };
  }

  save(checkpoint: Checkpoint): boolean {
    const record = {
      ...checkpoint,
      version: CHECKPOINT_VERSION,
      root: this.root,
      sessionId: this.sessionId,
      completed: (checkpoint.completed ?? []).slice(-MAX_COMPLETED_STEPS),
      updatedAt: Date.now(),
    };
    try {
      writeJsonAtomic(this.file, record);
      return true;
    } catch (err) {
      logger.debug(`could not save checkpoint: ${ (err as Error).message}`);
      return false;
    }
  }

  clear() {
    try {
      fs.rmSync(this.file, { force: true });
    } catch (err) {
      logger.debug(`could not clear checkpoint: ${ (err as Error).message}`);
    }
  }
}

export function createCheckpointStore(p: { root: string; sessionId: string; }): CheckpointStore {
  return new CheckpointStore(p);
}

export function describeCompletedWork(checkpoint: Checkpoint | null): string {
  return resumeNote((checkpoint?.completed ?? []).filter((s) => s.ok));
}

