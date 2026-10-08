import path from 'node:path';

export type IndexHandle = import('../../context/workspace-index/_shared.ts').IndexHandle;

/** Does an import statement name this symbol as its target module? */
function moduleMatches(name: string, imp: string): boolean {
  if (!imp || !name) return false;
  if (imp === name) return true;
  const cleanName = name.replace(/\.(m|c)?[jt]sx?$/i, '');
  if (imp === cleanName) return true;
  const parts = imp.split('/');
  const last = parts[parts.length - 1] ?? '';
  const base = last.replace(/\.(m|c)?[jt]sx?$/i, '');
  if (base === cleanName) return true;
  if (name.startsWith('@') && (imp === name || imp.startsWith(`${name}/`))) return true;
  return false;
}

export interface IndexedSymbol {
  definitions: Map<string, { file: string; kind: string; }>;
  importers: Map<string, string[]>;
}

/** Definitions (file-level) and importing files of one symbol or module name, from the workspace index. */
export function lookupSymbol(index: IndexHandle, name: string, relOf: (abs: string) => string): IndexedSymbol {
  const db = index.db;

  const defRows = db
    .prepare(
      `SELECT s.kind AS kind, s.name AS name, p.root AS proot, f.rel_path AS rel
       FROM symbols s
       JOIN files f ON f.id = s.file_id
       JOIN projects p ON p.id = f.project_id
       WHERE s.name = ?
       ORDER BY s.name`
    )
    .all(name) as Array<{ kind: string; name: string; proot: string; rel: string; }>;

  const definitions = new Map<string, { file: string; kind: string; }>();
  for (const d of defRows) {
    const abs = path.join(d.proot, d.rel);
    const key = path.resolve(abs);
    if (!definitions.has(key)) definitions.set(key, { file: relOf(abs), kind: d.kind });
  }

  const impRows = db
    .prepare(
      `SELECT p.root AS proot, f.rel_path AS rel, f.imports_json AS json
       FROM files f
       JOIN projects p ON p.id = f.project_id
       WHERE f.imports_json LIKE ?
       LIMIT 400`
    )
    .all(`%${name}%`) as Array<{ proot: string; rel: string; json: string; }>;

  const importers = new Map<string, string[]>();
  for (const row of impRows) {
    let arr: string[] = [];
    try {
      arr = JSON.parse(row.json);
    } catch {
      continue;
    }
    const matched = arr.filter((imp: string) => moduleMatches(name, String(imp)));
    if (!matched.length) continue;
    const file = relOf(path.join(row.proot, row.rel));
    const existing = importers.get(file) ?? [];
    for (const m of matched) if (!existing.includes(m)) existing.push(m);
    importers.set(file, existing);
  }

  return { definitions, importers };
}
