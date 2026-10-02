import path from 'node:path';

import type { IndexHandle } from './_shared';
import { MAX_SCOPE_PROJECTS } from './_shared';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'please', 'can', 'you', 'your', 'this', 'that',
  'these', 'those', 'there', 'here', 'into', 'from', 'have', 'has', 'will',
  'would', 'should', 'could', 'are', 'was', 'were', 'but', 'not', 'all', 'any',
  'some', 'just', 'need', 'want', 'let', 'make', 'create', 'add', 'fix', 'edit',
  'update', 'delete', 'remove', 'change', 'write', 'read', 'build', 'run',
  'test', 'review', 'check', 'look', 'show', 'help', 'about', 'what', 'how',
  'why', 'when', 'where', 'which', 'code', 'project', 'file', 'folder', 'dir',
]);

const KNOWN_FILE_EXTS = new Set([
  'js','jsx','ts','tsx','mjs','cjs','py','cs','go','rs','java','kt','swift','php','rb','json','toml','yaml','yml','md','sh','css','html','xml','sql','gradle','sln','slnx','csproj','fsproj','vbproj','xaml','razor',
]);

function tokenize(input: string): Set<string> {
  const raw = String(input ?? '').toLowerCase();
  const parts = raw.match(/[a-z0-9][a-z0-9_./-]*/g) ?? [];
  const out = new Set<string>();
  for (const p of parts) {
    const clean = p.split('/').pop() ?? p;
    const m = /\.([a-z0-9]+)$/i.exec(clean);
    const ext = m ? m[1].toLowerCase() : '';
    // Only strip a *known* file extension (e.g. index.js → index).
    const base = ext && KNOWN_FILE_EXTS.has(ext) ? clean.slice(0, -(ext.length + 1)) : clean;
    if (base.length >= 3 && base !== clean && !STOPWORDS.has(base)) out.add(base);
    if (p.length >= 3 && !STOPWORDS.has(p)) out.add(p);
  }
  return out;
}

/** Is this indexed project actually part of the workspace we are working in? */
function insideWorkspace(root: string, projectRoot: unknown): boolean {
  const base = path.resolve(String(root ?? ''));
  const target = path.resolve(String(projectRoot ?? ''));
  if (!base || !target) return false;
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function resolveTaskScope(handle: IndexHandle | null | undefined, root: string, input: string): {
  roots: string[];
  stackInfos: unknown[];
  activeProject: { id: unknown; root: string; name: string; } | null;
  confidence: string;
} {
  const empty = { roots: [] as string[], stackInfos: [] as unknown[], activeProject: null as { id: unknown; root: string; name: string; } | null, confidence: 'none' };
  const db = handle?.db;
  if (!db) return empty;

  const tokens = tokenize(input);
  const projects = (
    db.prepare('SELECT id, root, name, search_text, stacks_json FROM projects').all() as any[]
  ).filter((p) => insideWorkspace(root, p?.root));
  if (projects.length === 0) return empty;

  const scores = new Map();
  const strongSignal = new Set();
  for (const p of projects) {
    const text = String(p.search_text ?? '');
    let score = 0;
    for (const t of tokens) if (text.includes(t)) score += 1;
    const nameLower = String(p.name ?? '').toLowerCase();
    if (nameLower.length >= 3) {
      if (tokens.has(nameLower)) {
        score += 5;
        strongSignal.add(p.id);
      } else {
        const segs = nameLower.split(/[.\-_]/).filter((s) => s.length >= 3);
        if (segs.length > 1 && segs.every((s) => tokens.has(s))) {
          score += 5;
          strongSignal.add(p.id);
        }
      }
    }
    if (score > 0) scores.set(p.id, score);
  }

  const mentioned = new Set(
    [...String(input ?? '').matchAll(/\b[\w./-]+\.(?:js|jsx|ts|tsx|py|cs|go|rs|json|toml|md|sh|ya?ml|css|html)\b/gi)].map(
      (m) => m[0].toLowerCase()
    )
  );
  if (mentioned.size > 0) {
    const stmt = db.prepare('SELECT project_id FROM files WHERE rel_path = ? OR rel_path LIKE ?');
    for (const rel of mentioned) {
      const row = (stmt.get(rel, `%/${rel}`) as any);
      if (row) {
        scores.set(row.project_id, (scores.get(row.project_id) ?? 0) + 2);
        strongSignal.add(row.project_id);
      }
    }
  }

  if (scores.size === 0) return empty;

  const top = Math.max(...scores.values());
  const scoped = new Set();
  for (const [id, score] of scores) if (score >= top) scoped.add(id);

  const deps = (
    db.prepare('SELECT project_id, target_project_id FROM dependencies WHERE kind = ? AND target_project_id IS NOT NULL').all('internal') as any[]
  );
  const graph = new Map();
  for (const d of deps) {
    const list = graph.get(d.project_id) ?? [];
    list.push(d.target_project_id);
    graph.set(d.project_id, list);
  }
  const queue = [...scoped];
  while (queue.length) {
    const cur = (queue.shift() as number);
    for (const next of graph.get(cur) ?? []) {
      if (!scoped.has(next)) {
        scoped.add(next);
        queue.push(next);
      }
    }
  }

  const scopedProjects = projects.filter((p) => scoped.has(p.id));
  const roots = scopedProjects.map((p) => p.root);
  // Every candidate was outside the workspace — a scope naming nothing we can touch is not a narrow scope, it is no scope.
  if (roots.length === 0) return empty;
  const stackInfos = scopedProjects
    .slice(0, MAX_SCOPE_PROJECTS)
    .flatMap((p) => {
      try {
        return JSON.parse(p.stacks_json ?? '[]');
      } catch {
        return [];
      }
    });

  let activeId: any = null;
  let best = -1;
  for (const [id, score] of scores) {
    if (!scoped.has(id)) continue;
    if (score > best) {
      best = score;
      activeId = id;
    }
  }
  // Always expose the best as activeProject, even on a tie, so a root `dotnet test` does not run every project.
  const active = activeId != null ? scopedProjects.find((p) => p.id === activeId) ?? null : null;

  // A `task_scopes` row used to be written here, and a `sessions` row on every process launch.

  return {
    roots,
    stackInfos,
    activeProject: active ? { id: active.id, root: active.root, name: active.name } : null,
    confidence: active ? 'high' : 'low',
  };
}
