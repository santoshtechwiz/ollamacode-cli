import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

import { STORAGE } from '../../protocol';
import { logger } from '../../core/logger';
import { runChild } from '../../env/process/index';
import { walkFiles, BINARY_EXTENSIONS } from '../../tool/filesystem/_fs';
import { ensureOwnExclude } from '../../tool/git/_git';
import { detectStacks } from '../../env/tooling/detector';
import { detectPackageManager } from '../../env/tooling/probe';
import {
  SCHEMA,
  SCHEMA_VERSION,
  MAX_INDEX_FILES,
  MAX_WALK_DEPTH,
  MAX_SCAN_BYTES,
  MAX_EDGE_RESOLUTIONS,
  isInside,
  relSlash,
  forward,
  statSafe,
  hashFile,
  norm,
  type FileRow,
  type IndexHandle,
} from './_shared';
import { scanSource } from './search';
import { sourceRulesFor } from '../../env/languages';
import { isProjectMarker, MANIFEST_FILES, outputDirsAt } from '../../env/project-layout';

async function discoverProjects(root: string, signal?: AbortSignal): Promise<Array<{ abs: string; markers: string[]; }>> {
  const byDir = new Map();
  for await (const { abs, rel } of walkFiles(root, {
    maxDepth: MAX_WALK_DEPTH,
    maxEntries: MAX_INDEX_FILES,
    signal,
  })) {
    if (signal?.aborted) break;
    const base = path.basename(rel);
    if (isProjectMarker(base)) {
      const dir = path.dirname(abs);
      const list = byDir.get(dir) ?? [];
      list.push(base);
      byDir.set(dir, list);
    }
  }
  return [...byDir.keys()]
    .sort((a, b) => a.length - b.length)
    .map((dir) => ({ abs: dir, markers: byDir.get(dir) ?? [] }));
}


async function walkProjectFiles(projectRoot: string, { signal, cap = MAX_INDEX_FILES, hash = true, scan = true, excludeDirs = [] }: { signal?: AbortSignal; cap?: number; hash?: boolean; scan?: boolean; excludeDirs?: string[]; } = {}): Promise<FileRow[]> {
  const rows: FileRow[] = [];
  const excluded = [...excludeDirs.filter((d) => d !== projectRoot), ...outputDirsAt(projectRoot)];
  for await (const { abs, rel } of walkFiles(projectRoot, { maxDepth: MAX_WALK_DEPTH, maxEntries: cap, signal })) {
    if (signal?.aborted) break;
    if (excluded.some((d) => isInside(d, abs))) continue;
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    const st = await statSafe(abs);
    if (!st) continue;
    const fileHash = hash ? await hashFile(abs, st) : null;
    let imports: string[] = [];
    let exports: string[] = [];
    let symbols: { kind: string; name: string; }[] = [];
    if (scan && st.size <= MAX_SCAN_BYTES && sourceRulesFor(ext)) {
      const content = await fsp.readFile(abs, 'utf8').catch(() => '');
      if (content) {
        const scanned = scanSource(content, ext);
        imports = scanned.imports;
        exports = scanned.exports;
        symbols = scanned.symbols;
      }
    }
    rows.push({
      rel: forward(rel),
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
      hash: fileHash,
      imports,
      exports,
      symbols,
    });
  }
  return rows;
}

/** Attributes of every MSBuild item tag, in any order or layout; just enough to read Include/Version without an XML parser. */
function msbuildItemAttrs(xml: string, tag: string): Array<Record<string, string>> {
  const items: Array<Record<string, string>> = [];
  const tagRe = new RegExp(`<${tag}\\b([^>]*)/?>`, 'gi');
  const attrRe = /([A-Za-z_][\w.:-]*)\s*=\s*"([^"]*)"/g;
  for (const tagMatch of xml.matchAll(tagRe)) {
    const attrs: Record<string, string> = {};
    for (const attrMatch of tagMatch[1].matchAll(attrRe)) attrs[attrMatch[1]] = attrMatch[2];
    items.push(attrs);
  }
  return items;
}

async function scanDependencies(projectRoot: string, siblingNameToId: Map<string, number>, projectRoots: Map<string, number> = new Map()): Promise<Array<{ name: string; kind: 'package' | 'internal'; version: string | null; target_project_id: number | null; }>> {
  const deps: Array<{ name: string; kind: 'package' | 'internal'; version: string | null; target_project_id: number | null; }> = [];
  const seen = new Set<string>();
  const addPackage = (name: unknown, version: unknown) => {
    const t = String(name ?? '').trim().replace(/^['"]|['"]$/g, '');
    if (!t || seen.has(t)) return;
    seen.add(t);
    const target = siblingNameToId.get(t);
    deps.push({
      name: t,
      kind: target != null ? 'internal' : 'package',
      version: version ? String(version) : null,
      target_project_id: target ?? null,
    });
  };
  const addProjectReference = (rawPath: unknown, fromDir: string) => {
    const rel = String(rawPath ?? '').trim();
    const key = `csproj-ref:${fromDir}:${rel}`;
    if (!rel || seen.has(key)) return;
    seen.add(key);
    const targetDir = path.dirname(path.resolve(fromDir, rel));
    for (const [root, id] of projectRoots) {
      if (root === targetDir || isInside(root, targetDir)) {
        deps.push({ name: rel, kind: 'internal', version: null, target_project_id: id });
        return;
      }
    }
  };

  const pkg = await fsp.readFile(path.join(projectRoot, 'package.json'), 'utf8').catch((): null => null);
  if (pkg) {
    try {
      const parsed = JSON.parse(pkg);
      const all = { ...parsed.dependencies, ...parsed.devDependencies };
      for (const [name, version] of Object.entries(all)) addPackage(name, version);
    } catch { /* unparseable manifest: metadata only */ }
  }

  const req = await fsp.readFile(path.join(projectRoot, 'requirements.txt'), 'utf8').catch((): null => null);
  if (req) {
    for (const raw of req.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('-')) continue;
      const m = /^([^<>=!~[\s]+)/.exec(line);
      if (m) addPackage(m[1], line.slice(m[1].length));
    }
  }

  const entries = await fsp.readdir(projectRoot, { withFileTypes: true }).catch((): any[] => []);
  const csprojNames = entries.filter((e: any) => e.isFile() && /\.(cs|fs|vb)proj$/i.test(e.name)).map((e: any) => e.name);
  for (const name of csprojNames) {
    const csprojPath = path.join(projectRoot, name);
    const csproj = await fsp.readFile(csprojPath, 'utf8').catch((): null => null);
    if (!csproj) continue;
    for (const attrs of msbuildItemAttrs(csproj, 'PackageReference')) {
      if (attrs.Include) addPackage(attrs.Include, attrs.Version ?? null);
    }
    for (const attrs of msbuildItemAttrs(csproj, 'ProjectReference')) {
      if (attrs.Include) addProjectReference(attrs.Include, projectRoot);
    }
  }

  return deps;
}

function resolveEdge(projectRoot: string, fileRel: string, target: string, pkgNameToId: Map<string, number>, projectIds: Map<string, number>) {
  const t = String(target ?? '');
  if (!t || t.startsWith('/') || t.includes('\0')) return null;

  if (t.startsWith('.')) {
    const candidate = path.resolve(path.dirname(path.join(projectRoot, fileRel)), t);
    for (const other of projectIds.keys()) {
      if (other === projectRoot || isInside(other, projectRoot)) continue;
      if (isInside(other, candidate)) return projectIds.get(other);
    }
    return null;
  }

  return pkgNameToId.get(t) ?? null;
}

function workspaceDbKey(root: string): string {
  return norm(path.resolve(root));
}

export async function openWorkspaceIndex(
  root: string,
  { signal, force }: { signal?: AbortSignal; force?: boolean } = {}
): Promise<IndexHandle | null> {
  const base = path.resolve(root);
  const dbKey = workspaceDbKey(root);
  let db: any = null;
  try {
    await removeLegacyIndex(base);
    await fsp.mkdir(path.join(base, STORAGE.INDEX_DIR), { recursive: true });
    db = new Database(path.join(base, STORAGE.INDEX_DIR, 'workspace.db'));
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = NORMAL');
    db.exec(SCHEMA);
  } catch (err) {
    logger.debug(`workspace index unavailable: ${(err as Error).message}`);
    try { db?.close(); } catch { /* ignore */ }
    return null;
  }

  try {
    let gitTracked = false;
    try {
      ({ tracked: gitTracked } = await ensureGitIgnoresIndex(base));
    } catch (err) {
      logger.debug(`git hygiene for ${OWN_DIR} skipped: ${(err as Error).message}`);
    }
    if (gitTracked) {
      logger.warn(
        `${STORAGE.INDEX_DIR}/ is tracked in git — this blocks git checkout/stash whenever the index changes. ` +
          `Untrack it once with: git rm -r --cached ${STORAGE.INDEX_DIR}/ (the files stay on disk).`
      );
    }
    const now = Date.now();
    // opened_at identifies the indexed content; roots are case-normalized so case variants never become two workspaces.
    let workspaceId: number;
    {
      const dups = db.prepare('SELECT id, root FROM workspaces WHERE LOWER(root)=LOWER(?)').all(dbKey) as any[];
      if (dups.length > 1) {
        const keep = dups.sort((a: any, b: any) => a.id - b.id)[0];
        for (const dup of dups) {
          if (dup.id === keep.id) continue;
          const pids = (db.prepare('SELECT id FROM projects WHERE workspace_id=?').all(dup.id) as any[]).map((r: any) => r.id);
          if (pids.length) {
            for (const sql of projectRowDeletes(pids)) try { db.prepare(sql).run(); } catch {}
            try { db.prepare(`DELETE FROM projects WHERE workspace_id=?`).run(dup.id); } catch {}
          }
          try { db.prepare('DELETE FROM workspaces WHERE id=?').run(dup.id); } catch {}
        }
        db.prepare('UPDATE workspaces SET root=?, opened_at=? WHERE id=?').run(dbKey, now, keep.id);
        workspaceId = keep.id;
      } else if (dups.length === 1) {
        db.prepare('UPDATE workspaces SET root=?, opened_at=? WHERE id=?').run(dbKey, now, dups[0].id);
        workspaceId = dups[0].id;
      } else {
        db.prepare('INSERT INTO workspaces (root, opened_at) VALUES (?, ?)').run(dbKey, now);
        workspaceId = (db.prepare('SELECT id FROM workspaces WHERE root=?').get(dbKey) as any).id;
      }
    }

    const version = db.pragma('user_version', { simple: true }) as number;
    if (force || typeof version !== 'number' || version !== SCHEMA_VERSION) {
      const projects = await fullRebuild(db, workspaceId, base, signal);
      db.pragma('user_version = ' + SCHEMA_VERSION);
      logger.debug(`workspace index: full rebuild, ${projects.length} project(s)`);
      return makeHandle(db, base, projects, gitTracked);
    }

    // Stored rows serve now and settle against the tree in the background; one whose project file is gone is dropped up front.
    const projects = readStoredProjects(db, workspaceId).filter((p) => fs.existsSync(path.join(p.root, p.marker ?? '')));
    const handle = makeHandle(db, base, projects, gitTracked);
    track(
      handle,
      differentialRefresh(handle, workspaceId, base, signal).then(
        (stats) =>
          logger.debug(
            `workspace index reuse: ${stats.added} project(s) added, ${stats.removed} removed, ` +
              `${stats.refreshed} meta, ${stats.rescanned} file(s) rescanned, ${stats.deleted} removed`
          ),
        (err) => logger.debug(`workspace index reuse failed: ${(err as Error).message}`)
      )
    );
    return handle;
  } catch (err) {
    logger.debug(`workspace index failed: ${(err as Error).message}`);
    try { db.close(); } catch { /* ignore */ }
    return null;
  }
}

async function fullRebuild(
  db: any,
  workspaceId: number,
  base: string,
  signal?: AbortSignal
): Promise<IndexHandle['projects']> {
  const projectDirs = await discoverProjects(base, signal);

    const rows: any[] = [];
    const projectIds = new Map();

    for (const { abs, markers } of projectDirs) {
      if (signal?.aborted) break;
      const stacks = await detectStacks(abs).catch((): import('../../types.ts').StackInfo[] => []);
      const parent = [...rows]
        .filter((p) => p.root !== abs && isInside(p.root, abs))
        .sort((a, b) => b.root.length - a.root.length)[0];
      rows.push({
        root: abs,
        name: path.basename(abs) || 'workspace',
        parentRoot: parent?.root ?? null,
        marker: markers[0] ?? null,
        packageManager: markers.includes('package.json') ? await detectPackageManager(abs).catch(() => 'npm') : null,
        stacks,
      });
    }

    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM symbols WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?)').run(workspaceId);
    db.prepare('DELETE FROM files WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?)').run(workspaceId);
    db.prepare(
      'DELETE FROM dependencies WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?) OR target_project_id IN (SELECT id FROM projects WHERE workspace_id = ?)'
    ).run(workspaceId, workspaceId);
    db.prepare('DELETE FROM projects WHERE workspace_id = ?').run(workspaceId);
    db.pragma('foreign_keys = ON');

    const insertProject = db.prepare(
      'INSERT INTO projects (workspace_id, root, name, parent_id, marker, package_manager, stacks_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const projects: any[] = [];
    const pkgNameToId = new Map();
    for (const row of rows) {
      if (signal?.aborted) break;
      const pkgName = await readPackageName(row.root);
      const info = insertProject.run(
        workspaceId,
        row.root,
        pkgName ?? row.name,
        row.parentRoot ? (projectIds.get(row.parentRoot) ?? null) : null,
        row.marker,
        row.packageManager,
        JSON.stringify(row.stacks)
      );
      const id = Number(info.lastInsertRowid);
      projectIds.set(row.root, id);
      projects.push({ id, root: row.root, name: pkgName ?? row.name, marker: row.marker, stacks: row.stacks });
      if (pkgName) pkgNameToId.set(pkgName, id);
    }

    const insertCommand = db.prepare('INSERT INTO commands (project_id, verb, argv_json) VALUES (?, ?, ?)');
    for (const p of projects) insertStackCommands(insertCommand, p.id, p.stacks);

    const insertFile = db.prepare(
      'INSERT INTO files (project_id, rel_path, size, mtime, hash, imports_json, exports_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const insertSymbol = db.prepare('INSERT INTO symbols (project_id, file_id, kind, name) VALUES (?, ?, ?, ?)');
    const insertDep = db.prepare(
      'INSERT INTO dependencies (project_id, name, kind, version, target_project_id) VALUES (?, ?, ?, ?, ?)'
    );

    let filesSeen = 0;
    let edgesLeft = MAX_EDGE_RESOLUTIONS;
    const edgeSeen = new Set();
    const childrenByProject = new Map();
    for (const row of rows) {
      const kids = rows.filter((r) => r.parentRoot === row.root);
      childrenByProject.set(row.root, kids.map((k) => k.root));
    }
    for (const p of projects) {
      if (signal?.aborted) break;
      const deps = await scanDependencies(p.root, pkgNameToId, projectIds);
      for (const d of deps) {
        if (d.kind === 'internal' && d.target_project_id != null) {
          const key = `${p.id}:${d.target_project_id}`;
          if (!edgeSeen.has(key)) {
            edgeSeen.add(key);
            insertDep.run(p.id, d.name, d.kind, d.version, d.target_project_id);
            edgesLeft -= 1;
          }
        } else {
          insertDep.run(p.id, d.name, d.kind, d.version, d.target_project_id);
        }
      }

      const fileRows = await walkProjectFiles(p.root, { signal, excludeDirs: childrenByProject.get(p.root) ?? [] });
      db.exec('BEGIN');
      try {
        for (const row of fileRows) {
          if (filesSeen >= MAX_INDEX_FILES) break;
          filesSeen += 1;
          const fi = insertFile.run(
            p.id, row.rel, row.size, row.mtime, row.hash,
            JSON.stringify(row.imports), JSON.stringify(row.exports)
          );
          const fileId = Number(fi.lastInsertRowid);
          for (const s of row.symbols) insertSymbol.run(p.id, fileId, s.kind, s.name);

          if (edgesLeft > 0) {
            for (const target of row.imports) {
              if (edgesLeft <= 0) break;
              const targetId = resolveEdge(p.root, row.rel, target, pkgNameToId, projectIds);
              if (targetId != null && targetId !== p.id) {
                const key = `${p.id}:${targetId}`;
                if (!edgeSeen.has(key)) {
                  edgeSeen.add(key);
                  insertDep.run(p.id, target, 'internal', null, targetId);
                  edgesLeft -= 1;
                }
              }
            }
          }
        }
        db.exec('COMMIT');
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already aborted */ }
        throw err;
      }
    }

    logger.debug(`workspace index: ${projects.length} project(s), ${filesSeen} file(s) indexed`);
    return projects;
}

function makeHandle(db: any, base: string, projects: IndexHandle['projects'], gitTracked: boolean): IndexHandle {
  const handle = {
    db,
    root: base,

    projects,
    gitTracked,
    pending: new Set<Promise<unknown>>(),
    onChange() {},
    stamp() {
      const row = db.prepare('SELECT opened_at FROM workspaces WHERE root = ?').get(base) as any;
      return `${SCHEMA_VERSION}:${row?.opened_at ?? ''}`;
    },
    async close() {
      try { await Promise.allSettled(handle.pending); } catch { /* best effort */ }
      try { db.close(); } catch { /* ignore */ }
    },
  } as IndexHandle;
  handle.onChange = (op, rel, type) => onChange(handle, op, rel, type);
  return handle;
}

function parseStacks(json: string): import('../../types.ts').StackInfo[] {
  try {
    const parsed = JSON.parse(json ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readStoredProjects(db: any, workspaceId: number): IndexHandle['projects'] {
  return (
    db
      .prepare('SELECT id, root, name, marker, stacks_json FROM projects WHERE workspace_id = ? ORDER BY id')
      .all(workspaceId) as any[]
  ).map((row) => ({
    id: row.id,
    root: row.root,
    name: row.name,
    marker: row.marker ?? null,
    stacks: parseStacks(row.stacks_json),
  }));
}

/** Reconcile stored rows with the current tree (size+mtime as the unchanged test) instead of a full rebuild; /reindex restores import edges. */
async function differentialRefresh(handle: IndexHandle, workspaceId: number, base: string, signal?: AbortSignal) {
  const { db } = handle;

  const projectDirs = await discoverProjects(base, signal);
  const markersByRoot = new Map(projectDirs.map((d) => [d.abs, d.markers]));

  const stored = (
    db.prepare('SELECT id, root, marker FROM projects WHERE workspace_id = ?').all(workspaceId) as any[]
  );
  const gone = stored.filter((p) => !markersByRoot.has(p.root));
  const live = stored.filter((p) => markersByRoot.has(p.root));
  let removed = 0;
  tx(db, () => {
    // Foreign keys are on: a removed parent first hands its children to the nearest surviving ancestor, or the delete fails and rolls back every removal.
    for (const p of gone) {
      const heir = live.filter((o) => isInside(o.root, p.root)).sort((a, b) => b.root.length - a.root.length)[0];
      db.prepare('UPDATE projects SET parent_id = ? WHERE parent_id = ?').run(heir?.id ?? null, p.id);
    }
    for (const p of gone) {
      db.prepare('DELETE FROM dependencies WHERE project_id = ? OR target_project_id = ?').run(p.id, p.id);
      db.prepare('DELETE FROM symbols WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM files WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM commands WHERE project_id = ?').run(p.id);
      db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
      removed += 1;
    }
  });

  const keptRoots = new Set(stored.map((p) => p.root));
  const projectIds = new Map<string, number>();
  const allRoots: string[] = [];
  for (const p of live) {
    projectIds.set(p.root, p.id);
    allRoots.push(p.root);
  }

  const newProjects: {
    abs: string;
    stacks: import('../../types.ts').StackInfo[];
    parentRoot: string | null;
    name: string;
    pkgName: string | null;
    packageManager: string | null;
  }[] = [];
  let added = 0;
  for (const d of projectDirs) {
    if (signal?.aborted) break;
    if (projectIds.has(d.abs)) continue;
    const stacks = await detectStacks(d.abs).catch((): import('../../types.ts').StackInfo[] => []);
    const parent =
      [...allRoots]
        .filter((r) => r !== d.abs && isInside(r, d.abs))
        .sort((a, b) => b.length - a.length)[0] ?? null;
    const name = path.basename(d.abs) || 'workspace';
    const pkgName = await readPackageName(d.abs);
    newProjects.push({
      abs: d.abs,
      stacks,
      parentRoot: parent,
      name,
      pkgName,
      packageManager: d.markers.includes('package.json') ? await detectPackageManager(d.abs).catch(() => 'npm') : null,
    });
    allRoots.push(d.abs);
    added += 1;
  }

  if (newProjects.length) {
    tx(db, () => {
      const insertProject = db.prepare(
        'INSERT INTO projects (workspace_id, root, name, parent_id, marker, package_manager, stacks_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );
      const idByAbs = new Map<string, number>();
      for (const row of newProjects) {
        const info = insertProject.run(
          workspaceId,
          row.abs,
          row.pkgName ?? row.name,
          row.parentRoot ? (projectIds.get(row.parentRoot) ?? null) : null,
          markersByRoot.get(row.abs)?.[0] ?? null,
          row.packageManager,
          JSON.stringify(row.stacks)
        );
        const id = Number(info.lastInsertRowid);
        idByAbs.set(row.abs, id);
        projectIds.set(row.abs, id);
      }
      const insertCommand = db.prepare('INSERT INTO commands (project_id, verb, argv_json) VALUES (?, ?, ?)');
      for (const row of newProjects) insertStackCommands(insertCommand, idByAbs.get(row.abs) as number, row.stacks);
    });
  }

  const allProjectRows = (
    db.prepare('SELECT id, root FROM projects WHERE workspace_id = ?').all(workspaceId) as any[]
  );
  const pkgNameToId = new Map<string, number>();
  for (const row of allProjectRows) {
    const pk = await readPackageName(row.root);
    if (pk) pkgNameToId.set(pk, row.id);
  }
  const depsByProject = new Map<number, Array<{ name: string; kind: string; version: string | null; target_project_id: number | null; }>>();
  for (const row of allProjectRows) {
    if (keptRoots.has(row.root)) continue;
    depsByProject.set(row.id, await scanDependencies(row.root, pkgNameToId, projectIds));
  }
  if (depsByProject.size) {
    tx(db, () => {
      const insertDep = db.prepare(
        'INSERT INTO dependencies (project_id, name, kind, version, target_project_id) VALUES (?, ?, ?, ?, ?)'
      );
      for (const [id, deps] of depsByProject) {
        for (const d of deps) insertDep.run(id, d.name, d.kind, d.version, d.target_project_id);
      }
    });
  }

  let refreshed = 0;
  for (const p of live) {
    if ((markersByRoot.get(p.root)?.[0] ?? null) !== p.marker) {
      await refreshProjectMeta(db, p.id, p.root);
      refreshed += 1;
    }
  }

  const childrenByProject = new Map<string, string[]>();
  for (const row of allProjectRows) {
    const kids = allProjectRows
      .filter((o) => o.root !== row.root && isInside(row.root, o.root))
      .map((o) => o.root);
    childrenByProject.set(row.root, kids);
  }
  let rescanned = 0;
  let deleted = 0;
  for (const row of allProjectRows) {
    if (signal?.aborted) break;
    const s = await syncProjectFiles(db, row.id, row.root, childrenByProject.get(row.root) ?? [], signal);
    rescanned += s.rescanned;
    deleted += s.deleted;
  }

  handle.projects.splice(0, handle.projects.length, ...readStoredProjects(db, workspaceId));
  return { added, removed, refreshed, rescanned, deleted };
}

async function syncProjectFiles(
  db: any,
  projectId: number,
  projectRoot: string,
  excludeDirs: string[],
  signal?: AbortSignal
): Promise<{ rescanned: number; deleted: number; }> {
  const known = new Map<string, { id: number; size: number; mtime: number; }>();
  for (const row of db.prepare('SELECT id, rel_path, size, mtime FROM files WHERE project_id = ?').all(projectId) as any[]) {
    known.set(row.rel_path, { id: row.id, size: row.size, mtime: row.mtime });
  }
  const excluded = [...excludeDirs.filter((d) => d !== projectRoot), ...outputDirsAt(projectRoot)];
  const seen = new Set<string>();
  let rescanned = 0;
  for await (const { abs, rel } of walkFiles(projectRoot, { maxDepth: MAX_WALK_DEPTH, maxEntries: MAX_INDEX_FILES, signal })) {
    if (signal?.aborted) break;
    if (excluded.some((d) => isInside(d, abs))) continue;
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) continue;
    const st = await statSafe(abs);
    if (!st) continue;
    const key = forward(rel);
    const prev = known.get(key);
    seen.add(key);
    if (prev && prev.size === st.size && prev.mtime === Math.floor(st.mtimeMs)) continue;
    rescanned += 1;
    await upsertFile(db, projectId, abs, key);
  }
  let deleted = 0;
  tx(db, () => {
    for (const [rel, row] of known) {
      if (seen.has(rel)) continue;
      db.prepare('DELETE FROM symbols WHERE file_id = ?').run(row.id);
      db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
      deleted += 1;
    }
  });
  return { rescanned, deleted };
}

async function readPackageName(root: string) {
  const pkg = await fsp.readFile(path.join(root, 'package.json'), 'utf8').catch((): null => null);
  if (!pkg) return null;
  try {
    const name = JSON.parse(pkg).name;
    return typeof name === 'string' && name ? name : null;
  } catch {
    return null;
  }
}

const OWN_DIR = `${STORAGE.PROJECT_DIR}/`;
const DB_FILES = ['workspace.db', 'workspace.db-journal', 'workspace.db-wal', 'workspace.db-shm'];

/**
 * The index once lived in .agent/, a folder other tools keep their own files in. Its database files are removed
 * (unless git tracks them: deleting those would change the person's repository), and the folder too once nothing
 * else is left in it; anything another tool put there stays.
 */
async function removeLegacyIndex(base: string): Promise<void> {
  const legacy = path.join(base, STORAGE.LEGACY_INDEX_DIR);
  const present = DB_FILES.filter((f) => fs.existsSync(path.join(legacy, f)));
  if (!present.length || (await isTracked(base, `${STORAGE.LEGACY_INDEX_DIR}/`))) return;
  for (const f of present) await fsp.unlink(path.join(legacy, f)).catch(() => {});
  await fsp.rmdir(legacy).catch(() => { /* not empty: the rest is not ocode's */ });
}

async function isTracked(base: string, rel: string): Promise<boolean> {
  const out = await runChild({
    file: 'git',
    args: ['ls-files', rel],
    options: { cwd: base, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    timeoutMs: 5000,
  }).catch((): null => null);
  return Boolean(out && out.exitCode === 0 && out.stdout.trim().length > 0);
}

/** Keep ocode's folder out of git (the same exclude the session writes), and say whether git already tracks the index. */
async function ensureGitIgnoresIndex(base: string): Promise<{ tracked: boolean }> {
  await ensureOwnExclude(base);
  return { tracked: await isTracked(base, `${STORAGE.INDEX_DIR}/`) };
}

function projectForRel(db: any, root: string, rel: string) {
  const abs = path.resolve(root, rel.split('/').join(path.sep));
  const projects = (db.prepare('SELECT id, root FROM projects').all() as any[]);
  const hit = [...projects].sort((a, b) => b.root.length - a.root.length).find((p) => isInside(p.root, abs));
  return hit ?? null;
}

function onChange(handle: IndexHandle, op: string, rel: string, type: 'file' | 'dir') {
  const { db, root } = handle;
  if (!db || type !== 'file') return;
  const project = projectForRel(db, root, rel);
  if (!project) return;

  const abs = path.resolve(root, rel.split('/').join(path.sep));
  const projRel = relSlash(project.root, abs);

  if (op === 'delete') {
    const row = (
      db.prepare('SELECT id FROM files WHERE project_id = ? AND rel_path = ?').get(project.id, projRel) as any
    );
    if (row) {
      tx(db, () => {
        db.prepare('DELETE FROM symbols WHERE file_id = ?').run(row.id);
        db.prepare('DELETE FROM files WHERE id = ?').run(row.id);
      });
    }
  } else {
    track(handle, upsertFile(db, project.id, abs, projRel));
  }

  if (MANIFEST_FILES.has(path.basename(rel))) track(handle, refreshProjectMeta(db, project.id, project.root));
}

async function upsertFile(db: any, projectId: number, abs: string, rel: string) {
  const st = await statSafe(abs);
  if (!st) return;
  const ext = path.extname(rel).toLowerCase();
  const hash = await hashFile(abs, st);
  let imports: any[] = [];
  let exports: any[] = [];
  let symbols: any[] = [];
  if (st.size <= MAX_SCAN_BYTES && sourceRulesFor(ext)) {
    const content = await fsp.readFile(abs, 'utf8').catch(() => '');
    if (content) {
      const scanned = scanSource(content, ext);
      imports = scanned.imports;
      exports = scanned.exports;
      symbols = scanned.symbols;
    }
  }
  let fileId: number;
  tx(db, () => {
    const existing = (
      db.prepare('SELECT id FROM files WHERE project_id = ? AND rel_path = ?').get(projectId, rel) as any
    );
    if (existing) {
      db.prepare('UPDATE files SET size = ?, mtime = ?, hash = ?, imports_json = ?, exports_json = ? WHERE id = ?').run(
        st.size, Math.floor(st.mtimeMs), hash, JSON.stringify(imports), JSON.stringify(exports), existing.id
      );
      fileId = existing.id;
    } else {
      const info = db
        .prepare('INSERT INTO files (project_id, rel_path, size, mtime, hash, imports_json, exports_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(projectId, rel, st.size, Math.floor(st.mtimeMs), hash, JSON.stringify(imports), JSON.stringify(exports));
      fileId = Number(info.lastInsertRowid);
    }
    db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
    const ins = db.prepare('INSERT INTO symbols (project_id, file_id, kind, name) VALUES (?, ?, ?, ?)');
    for (const s of symbols) ins.run(projectId, fileId, s.kind, s.name);
  });
}

async function refreshProjectMeta(db: any, projectId: number, projectRoot: string) {
  try {
    const stacks = await detectStacks(projectRoot).catch((): import('../../types.ts').StackInfo[] => []);
    const allProjects = (db.prepare('SELECT id, root FROM projects').all() as any[]);
    const pkgNameToId = new Map();
    const projectRoots = new Map();
    for (const other of allProjects) {
      projectRoots.set(other.root, other.id);
      const name = await readPackageName(other.root);
      if (name) pkgNameToId.set(name, other.id);
    }
    const deps = await scanDependencies(projectRoot, pkgNameToId, projectRoots);
    tx(db, () => {
      db.prepare('DELETE FROM commands WHERE project_id = ?').run(projectId);
      insertStackCommands(db.prepare('INSERT INTO commands (project_id, verb, argv_json) VALUES (?, ?, ?)'), projectId, stacks);
      db.prepare('UPDATE projects SET stacks_json = ? WHERE id = ?').run(JSON.stringify(stacks), projectId);
      db.prepare('DELETE FROM dependencies WHERE project_id = ?').run(projectId);
      const insDep = db.prepare('INSERT INTO dependencies (project_id, name, kind, version, target_project_id) VALUES (?, ?, ?, ?, ?)');
      for (const d of deps) insDep.run(projectId, d.name, d.kind, d.version, d.target_project_id);
    });
  } catch (err) {
    logger.debug(`project re-index failed: ${(err as Error).message}`);
  }
}

function track(handle: IndexHandle, p: Promise<unknown>) {
  const pending = handle.pending;
  if (!pending) return;
  pending.add(p);
  const done = () => pending.delete(p);
  p.then(done, done);
}

export async function getWorkspaceStats(root: string): Promise<{
  exists: boolean; path: string; size: number; pages: number; workspaces: number;
  projects: number; files: number; symbols: number; dependencies: number; commands: number;
  orphanCommands: number; duplicateWorkspaces: number;
} | null> {
  const dbPath = path.join(path.resolve(root), STORAGE.INDEX_DIR, 'workspace.db');
  try { await fsp.stat(dbPath); } catch { return null; }
  let db: any = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const size = (await fsp.stat(dbPath)).size;
    const pages = (db.prepare('PRAGMA page_count').get() as any)?.page_count ?? (db.pragma('page_count', { simple: true }) as number);
    const workspaces = (db.prepare('SELECT COUNT(*) as c FROM workspaces').get() as any).c;
    const dupRows = db.prepare('SELECT LOWER(root) as k, COUNT(*) as c FROM workspaces GROUP BY k HAVING c>1').all() as any[];
    const duplicateWorkspaces = dupRows.reduce((n: number, r: any) => n + (r.c - 1), 0);
    const projects = (db.prepare('SELECT COUNT(*) as c FROM projects').get() as any).c;
    const files = (db.prepare('SELECT COUNT(*) as c FROM files').get() as any).c;
    const symbols = (db.prepare('SELECT COUNT(*) as c FROM symbols').get() as any).c;
    const dependencies = (db.prepare('SELECT COUNT(*) as c FROM dependencies').get() as any).c;
    const commands = (db.prepare('SELECT COUNT(*) as c FROM commands').get() as any).c;
    const orphanCommands = (db.prepare('SELECT COUNT(*) as c FROM commands WHERE project_id NOT IN (SELECT id FROM projects)').get() as any).c;
    return { exists: true, path: dbPath, size, pages: Number(pages) || 0, workspaces, projects, files, symbols, dependencies, commands, orphanCommands, duplicateWorkspaces };
  } catch { return null; } finally { try { db?.close(); } catch {} }
}

export async function pruneWorkspaceIndex(root: string): Promise<{
  duplicateWorkspaces: number; orphanCommands: number; orphanFiles: number;
  orphanSymbols: number; orphanDeps: number; vacuumed: boolean; before: number; after: number;
}> {
  const base = path.resolve(root);
  const dbPath = path.join(base, STORAGE.INDEX_DIR, 'workspace.db');
  let db: any = null;
  try { db = new Database(dbPath); } catch { return { duplicateWorkspaces: 0, orphanCommands: 0, orphanFiles: 0, orphanSymbols: 0, orphanDeps: 0, vacuumed: false, before: 0, after: 0 }; }
  try {
    const before = (await fsp.stat(dbPath).catch(() => ({ size: 0 } as any))).size ?? 0;
    let duplicateWorkspaces = 0;
    const dups = db.prepare('SELECT LOWER(root) as k, GROUP_CONCAT(id) as ids FROM workspaces GROUP BY k HAVING COUNT(*)>1').all() as any[];
    for (const row of dups) {
      const ids = String(row.ids).split(',').map((s: string) => Number(s)).sort((a: number, b: number) => a - b);
      const remove = ids.slice(1);
      for (const dupId of remove) {
        db.exec('BEGIN');
        try {
          const pids = (db.prepare('SELECT id FROM projects WHERE workspace_id=?').all(dupId) as any[]).map((r: any) => r.id);
          if (pids.length) {
            for (const sql of projectRowDeletes(pids)) db.prepare(sql).run();
            db.prepare(`DELETE FROM projects WHERE workspace_id=?`).run(dupId);
          }
          db.prepare('DELETE FROM workspaces WHERE id=?').run(dupId);
          db.exec('COMMIT');
          duplicateWorkspaces += 1;
        } catch { try { db.exec('ROLLBACK'); } catch {} }
      }
    }
    const orphanCommands = (db.prepare('SELECT COUNT(*) as c FROM commands WHERE project_id NOT IN (SELECT id FROM projects)').get() as any).c;
    if (orphanCommands > 0) db.prepare('DELETE FROM commands WHERE project_id NOT IN (SELECT id FROM projects)').run();
    const orphanFiles = (db.prepare('SELECT COUNT(*) as c FROM files WHERE project_id NOT IN (SELECT id FROM projects)').get() as any).c;
    if (orphanFiles > 0) db.prepare('DELETE FROM files WHERE project_id NOT IN (SELECT id FROM projects)').run();
    const orphanSymbols = (db.prepare('SELECT COUNT(*) as c FROM symbols WHERE project_id NOT IN (SELECT id FROM projects)').get() as any).c;
    if (orphanSymbols > 0) db.prepare('DELETE FROM symbols WHERE project_id NOT IN (SELECT id FROM projects)').run();
    const orphanDeps = (db.prepare('SELECT COUNT(*) as c FROM dependencies WHERE project_id NOT IN (SELECT id FROM projects) OR target_project_id NOT IN (SELECT id FROM projects)').get() as any).c;
    if (orphanDeps > 0) db.prepare('DELETE FROM dependencies WHERE project_id NOT IN (SELECT id FROM projects) OR target_project_id NOT IN (SELECT id FROM projects)').run();
    // Also handle case where file's project was deleted but symbol file_id orphan
    db.prepare('DELETE FROM symbols WHERE file_id NOT IN (SELECT id FROM files)').run();
    let vacuumed = false;
    try { db.exec('VACUUM'); vacuumed = true; } catch {}
    const after = (await fsp.stat(dbPath).catch(() => ({ size: 0 } as any))).size ?? 0;
    return { duplicateWorkspaces, orphanCommands, orphanFiles, orphanSymbols, orphanDeps, vacuumed, before, after };
  } finally { try { db.close(); } catch {} }
}

export async function clearWorkspaceIndex(root: string): Promise<{ removed: boolean; path: string }> {
  const dbPath = path.join(path.resolve(root), STORAGE.INDEX_DIR, 'workspace.db');
  const journal = `${dbPath}-journal`;
  const wal = `${dbPath}-wal`;
  const shm = `${dbPath}-shm`;
  let removed = false;
  for (const p of [dbPath, journal, wal, shm]) {
    try { await fsp.unlink(p); removed = true; } catch {}
  }
  try { await fsp.rm(path.join(path.resolve(root), STORAGE.INDEX_DIR), { recursive: true, force: true }); } catch {}
  // Recreate the empty folder so the next open finds it
  try { await fsp.mkdir(path.join(path.resolve(root), STORAGE.INDEX_DIR), { recursive: true }); } catch {}
  return { removed, path: dbPath };
}

/** Run a batch of writes in one transaction so the index is never half-updated; nested calls run inline. */
/** Every row that belongs to these projects, children first; the callers decide how a failed statement is handled. */
function projectRowDeletes(projectIds: number[]): string[] {
  const ids = projectIds.join(',');
  return [
    `DELETE FROM commands WHERE project_id IN (${ids})`,
    `DELETE FROM symbols WHERE project_id IN (${ids})`,
    `DELETE FROM symbols WHERE file_id IN (SELECT id FROM files WHERE project_id IN (${ids}))`,
    `DELETE FROM files WHERE project_id IN (${ids})`,
    `DELETE FROM dependencies WHERE project_id IN (${ids}) OR target_project_id IN (${ids})`,
  ];
}

const COMMAND_VERBS = ['test', 'build', 'check', 'lint', 'run', 'dev'] as const;

/** One `commands` row per verb a stack defines, in stack then verb order. */
function insertStackCommands(insert: { run: (...params: unknown[]) => unknown }, projectId: number, stacks: import('../../types.ts').StackInfo[]): void {
  for (const stack of stacks) {
    for (const verb of COMMAND_VERBS) {
      const argv = stack[verb];
      if (Array.isArray(argv) && argv.length) insert.run(projectId, verb, JSON.stringify(argv));
    }
  }
}

function tx(db: any, fn: () => void) {
  if (db.inTransaction) {
    fn();
    return;
  }
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* connection already aborted */ }
    throw err;
  }
}
