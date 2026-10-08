import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { canPlanTransition, PLAN_STATUS, TERMINAL_PLAN_STATUSES, MAX_PLANS_PER_WORKSPACE, PLAN_RECORD_VERSION, STORAGE } from '../../protocol';
import { homeDir, writeJsonAtomic } from '../../core/config';
import { normalizeRelPath } from '../../core/paths';


function activePointerName(workspaceRoot?: string): string {
  if (!workspaceRoot) return 'active.json';
  const hash = crypto.createHash('sha1').update(normalizeRelPath(workspaceRoot)).digest('hex').slice(0, 12);
  return `active-${hash}.json`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function userDataDir(): string {
  return path.join(homeDir(), STORAGE.USER_DATA_DIR);
}

function plansRoot(): string {
  return path.join(userDataDir(), STORAGE.PLANS_DIR);
}

function planDir(id: string): string {
  return path.join(plansRoot(), String(id));
}

function planFile(id: string): string {
  return path.join(planDir(id), STORAGE.PLAN_FILE);
}

function newPlanId(): string {
  return crypto.randomUUID();
}

function isPlanId(id: string): boolean {
  return UUID_RE.test(String(id ?? ''));
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** Minimal plan record for persistence (resume); progress is what the last settled turn found done. */
export interface PlanRecord {
  version?: number;
  id: string;
  title: string;
  task: string;
  status: PlanStatus;
  workspaceRoot?: string;
  sessionId?: string;
  supersedes?: string;
  createdAt: string;
  updatedAt: string;
  steps: string[];
  affectedFiles: { create: string[]; edit: string[]; del: string[]; };
  runs: string[];
  risks?: string;
  constraints?: string[];
  raw: string;
  failureReason?: string;
  doneSteps?: number[];
  ran?: string[];
}

type PlanStatus = typeof PLAN_STATUS[keyof typeof PLAN_STATUS];

function buildPlanRecord({
  id, title, task, plan, workspaceRoot, sessionId, supersedes, status = PLAN_STATUS.ACTIVE,
}: {
  id: string;
  title?: string;
  task?: string;
  plan: import('./plan.ts').Plan;
  workspaceRoot?: string;
  sessionId?: string;
  supersedes?: string;
  status?: PlanStatus;
}): PlanRecord {
  return {
    version: PLAN_RECORD_VERSION,
    id,
    title: String(title ?? plan?.summary ?? 'Untitled'),
    task: String(task ?? ''),
    status,
    workspaceRoot: workspaceRoot ? String(workspaceRoot) : undefined,
    sessionId: sessionId ? String(sessionId) : undefined,
    supersedes: supersedes ? String(supersedes) : undefined,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    steps: [...(plan.steps ?? [])],
    affectedFiles: {
      create: [...(plan.files?.create ?? [])],
      edit: [...(plan.files?.edit ?? [])],
      del: [...(plan.files?.del ?? [])],
    },
    runs: [...(plan.runs ?? [])],
    risks: String(plan.risks ?? ''),
    constraints: [...(plan.constraints ?? [])],
    raw: String(plan.raw ?? ''),
  };
}

class SimplePlanStore {
  root: string;

  constructor({ root = plansRoot() }: { root?: string } = {}) {
    this.root = root;
  }

  _dir(id: string): string {
    return path.join(this.root, String(id));
  }

  _file(id: string): string {
    return path.join(this._dir(id), STORAGE.PLAN_FILE);
  }

  _pointer(workspaceRoot?: string): string {
    return path.join(this.root, activePointerName(workspaceRoot));
  }

  create({
    plan, task = '', workspaceRoot, sessionId, status = PLAN_STATUS.ACTIVE,
  }: {
    plan: import('./plan.ts').Plan;
    task?: string;
    workspaceRoot?: string;
    sessionId?: string;
    status?: PlanStatus;
  }): { id: string; planPath: string; record: PlanRecord; } {
    const id = newPlanId();
    const previous = this.activeId(workspaceRoot) ?? undefined;
    const record = buildPlanRecord({
      id,
      title: plan?.summary,
      task,
      plan,
      workspaceRoot,
      sessionId,
      supersedes: previous && previous !== id ? previous : undefined,
      status,
    });
    const file = this._file(id);
    writeJsonAtomic(file, record);
    if (status === PLAN_STATUS.ACTIVE) {
      this._setActive(id, workspaceRoot);
      this._capWorkspace(workspaceRoot);
    }
    return { id, planPath: file, record };
  }

  get(id: string): PlanRecord | null {
    if (!isPlanId(id)) return null;
    const rec = readJson(this._file(id));
    if (!rec || rec.id !== id) return null;
    if ((rec.version ?? PLAN_RECORD_VERSION) !== PLAN_RECORD_VERSION) return null;
    return rec;
  }

  _update(id: string, fn: (rec: PlanRecord) => void): PlanRecord | null {
    const file = this._file(id);
    const rec = readJson(file);
    if (!rec) return null;
    const next = structuredClone(rec as PlanRecord);
    fn(next);
    next.updatedAt = new Date().toISOString();
    writeJsonAtomic(file, next);
    return next;
  }

  setStatus(id: string, status: PlanStatus, { reason, workspaceRoot }: { reason?: string; workspaceRoot?: string } = {}): PlanRecord | null {
    const before = readJson(this._file(id)) as PlanRecord | null;
    if (!before) return null;
    if (before.status === status || !canPlanTransition(before.status, status)) return before;
    const rec = this._update(id, (r) => {
      r.status = status;
      if (reason) r.failureReason = String(reason);
    });
    if (rec && (TERMINAL_PLAN_STATUSES as readonly string[]).includes(status)) {
      this._clearActive(workspaceRoot ?? rec.workspaceRoot);
    }
    return rec;
  }

  activeId(workspaceRoot?: string): string | null {
    const ptr = readJson(this._pointer(workspaceRoot));
    const id = ptr?.id;
    return isPlanId(id) ? id : null;
  }

  findActive(workspaceRoot?: string): PlanRecord | null {
    const id = this.activeId(workspaceRoot);
    const rec = id ? this.get(id) : null;
    if (!rec || (rec.status !== PLAN_STATUS.ACTIVE && rec.status !== PLAN_STATUS.NEEDS_REPLAN)) return null;
    return rec;
  }

  _setActive(id: string, workspaceRoot?: string): void {
    writeJsonAtomic(this._pointer(workspaceRoot), { id, updatedAt: new Date().toISOString() });
  }

  _clearActive(workspaceRoot?: string): void {
    try {
      fs.rmSync(this._pointer(workspaceRoot), { force: true });
    } catch { }
  }

  /** Delete old plan records for a workspace so at most MAX_PLANS_PER_WORKSPACE remain. */
  _capWorkspace(workspaceRoot?: string): void {
    if (!workspaceRoot) return;
    const root = normalizeRelPath(String(workspaceRoot));
    const all = this.list();
    const workspaceRecords = all.filter((r) => r.workspaceRoot && normalizeRelPath(String(r.workspaceRoot)) === root);
    for (const rec of workspaceRecords.slice(MAX_PLANS_PER_WORKSPACE)) {
      this.delete(rec.id);
    }
  }

  list(): PlanRecord[] {
    let entries;
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch {
      return [];
    }
    const recs: PlanRecord[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !isPlanId(e.name)) continue;
      const rec = readJson(path.join(this.root, e.name, STORAGE.PLAN_FILE));
      if (rec) recs.push(rec);
    }
    return recs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  delete(id: string): void {
    if (!isPlanId(id)) return;
    const workspaceRoot = this.get(id)?.workspaceRoot;
    try {
      fs.rmSync(this._dir(id), { recursive: true, force: true });
    } catch { }
    if (this.activeId(workspaceRoot) === id) this._clearActive(workspaceRoot);
  }
}

const store = new SimplePlanStore();

/** The plan id inside a plan reference — an id already, or the id segment of a `plans/<id>/plan.json` path. */
export function idFromPlanRef(ref: string | number): string | null {
  const s = String(ref ?? '');
  if (isPlanId(s)) return s;
  const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (isPlanId(parts[i])) return parts[i];
  }
  return null;
}

export function getPlanPath(cwd?: string): string {
  const id = store.activeId(cwd);
  return id ? planFile(id) : path.join(plansRoot(), 'PLAN.json');
}

export function createPlan({
  plan, task, workspaceRoot, sessionId, status,
}: {
  plan: import('./plan.ts').Plan;
  task?: string;
  workspaceRoot?: string;
  sessionId?: string;
  status?: PlanStatus;
}): { id: string; planPath: string; tasks: import('../../types.ts').PlanTask[]; record: PlanRecord; } {
  const { id, planPath, record } = store.create({ plan, task, workspaceRoot, sessionId, status });
  // Tasks no longer stored; return empty for compatibility
  return { id, planPath, tasks: [] as import('../../types.ts').PlanTask[], record };
}

export function getActivePlan(cwd?: string): PlanRecord | null {
  return store.findActive(cwd);
}

/** A stored plan's status; a missing plan reads as rejected. */
export function planStatus(planPath: string): PlanStatus {
  const id = idFromPlanRef(planPath);
  return (id && store.get(id)?.status) || PLAN_STATUS.REJECTED;
}

/** Saves what a turn finished, so a later session resumes from there instead of from zero. */
export function savePlanProgress(planPath: string, { doneSteps, ran }: { doneSteps: number[]; ran?: string[] }): void {
  const id = idFromPlanRef(planPath);
  if (id) store._update(id, (r) => { r.doneSteps = doneSteps; r.ran = ran ?? []; });
}

export function markPlanNeedsReplan(planPath: string, reason?: string): void {
  const id = idFromPlanRef(planPath);
  if (id) store.setStatus(id, PLAN_STATUS.NEEDS_REPLAN, { reason });
}

export function markPlanComplete(planPath: string): void {
  const id = idFromPlanRef(planPath);
  if (id) store.setStatus(id, PLAN_STATUS.DONE);
}

/** Remove a plan and its active pointer from disk. A plan lives for one session; nothing about it should outlast it. */
export function deletePlan(planPath: string): void {
  const id = idFromPlanRef(planPath);
  if (id) store.delete(id);
}

/** Remove this workspace's plans left by other sessions — and, with no session given, all of them. Returns how many went. */
export function clearWorkspacePlans(workspaceRoot: string, keepSessionId?: string): number {
  const root = normalizeRelPath(String(workspaceRoot ?? ''));
  let removed = 0;
  for (const rec of store.list()) {
    if (!rec.workspaceRoot || normalizeRelPath(String(rec.workspaceRoot)) !== root) continue;
    if (keepSessionId && rec.sessionId === keepSessionId) continue;
    store.delete(rec.id);
    removed += 1;
  }
  return removed;
}

/** Plans untouched this long belong to no running session. */
const STALE_PLAN_MS = 24 * 60 * 60 * 1000;

/** Remove plans from any workspace that no session can still be working on: the folder is gone, or nothing touched them for a day. */
export function pruneStalePlans(now = Date.now()): number {
  let removed = 0;
  for (const rec of store.list()) {
    const touched = Date.parse(String(rec.updatedAt ?? rec.createdAt ?? ''));
    const folderGone = Boolean(rec.workspaceRoot) && !fs.existsSync(String(rec.workspaceRoot));
    // An ended plan (done, failed, rejected, changed) has nothing left to offer anyone.
    const ended = rec.status !== PLAN_STATUS.ACTIVE && rec.status !== PLAN_STATUS.NEEDS_REPLAN;
    if (ended || folderGone || !Number.isFinite(touched) || now - touched > STALE_PLAN_MS) {
      store.delete(rec.id);
      removed += 1;
    }
  }
  return removed;
}

export function markPlanDoneByChoice(planPath: string, reason?: string): void {
  const id = idFromPlanRef(planPath);
  if (id) store.setStatus(id, PLAN_STATUS.DONE, { reason });
}

export function markPlanChanged(planPath: string): void {
  const id = idFromPlanRef(planPath);
  if (id) store.setStatus(id, PLAN_STATUS.CHANGED);
}

export function markPlanRejected(planPath: string): void {
  const id = idFromPlanRef(planPath);
  if (id) store.setStatus(id, PLAN_STATUS.REJECTED);
}

export function planFileExists(planPath: string): boolean {
  if (fs.existsSync(planPath)) return true;
  const id = idFromPlanRef(planPath);
  return id ? fs.existsSync(planFile(id)) : false;
}

export function isPlanComplete(rec: PlanRecord | null | undefined): boolean {
  return rec?.status === PLAN_STATUS.DONE;
}

export function planAttachable(planPath: string): boolean {
  const status = planStatus(planPath);
  return status === PLAN_STATUS.ACTIVE || status === PLAN_STATUS.NEEDS_REPLAN;
}

export function summarizeRecord(rec: PlanRecord): { id: string; title: string; status: string; done: number; total: number; createdAt: string | null; } | null {
  if (!rec) return null;
  return {
    id: rec.id,
    title: String(rec.title ?? rec.task ?? 'plan').replace(/\s+/g, ' ').trim().slice(0, 64),
    status: rec.status,
    done: rec.doneSteps?.length ?? 0,
    total: rec.steps?.length ?? 0,
    createdAt: rec.createdAt ?? null,
  };
}

export interface PlanTodoDetail {
  title: string;
  done: number;
  total: number;
  tasks: Array<{ index: number; text: string; status: string }>;
  next: { index: number } | null;
  planPath: string;
}

export function activePlanDetail(
  workspaceRoot?: string,
  _sessionId?: string,
): PlanTodoDetail | null {
  const rec = getActivePlan(workspaceRoot);
  if (!rec) return null;
  const planPath = planFile(rec.id);
  const tasks = (rec.steps ?? []).map((text, index) => ({
    index,
    text,
    status: rec.doneSteps?.includes(index) ? 'done' : 'pending',
  }));
  const next = tasks.find((task) => task.status !== 'done');
  return {
    title: rec.title ?? rec.task ?? 'plan',
    done: tasks.length - tasks.filter((task) => task.status !== 'done').length,
    total: tasks.length,
    tasks,
    next: next ? { index: next.index } : null,
    planPath,
  };
}

export function lastPlanFor(workspaceRoot?: string): PlanRecord | null {
  const records = store.list();
  if (records.length === 0) return null;
  if (!workspaceRoot) return records[0];
  const root = normalizeRelPath(String(workspaceRoot));
  const found = records.find((r) => {
    const w = r.workspaceRoot;
    return w && normalizeRelPath(w) === root;
  });
  return found ?? null;
}

export function planSnapshot(workspaceRoot?: string): import('../../protocol.ts').PlanRecordReference | null {
  const active = getActivePlan(workspaceRoot);
  const rec = active ?? lastPlanFor(workspaceRoot);
  if (!rec) return null;
  // No task counts stored; return zero counts.
  return {
    id: rec.id,
    planPath: planFile(rec.id),
    title: String(rec.title ?? rec.task ?? 'plan').replace(/\s+/g, ' ').trim().slice(0, 72),
    status: rec.status,
    done: 0,
    total: 0,
  };
}

export function listPlans(): PlanRecord[] {
  try {
    return store.list();
  } catch {
    return [];
  }
}