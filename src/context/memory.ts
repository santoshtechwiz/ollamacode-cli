import fs from 'node:fs';
import path from 'node:path';

import { MEMORY_VERSION, STORAGE } from '../protocol';
import { MEMORY_BLOCK_HEADER } from '../prompts/memory';
import { writeJsonAtomic } from '../core/config';

const MAX_CONVENTIONS = 30;
const MAX_FACTS = 20;

export interface MemoryFact {
  text: string;
  createdAt: number;
  source: 'user' | 'agent';
}

export interface ProjectMemory {
  version: number;
  updatedAt: number;
  project: { name?: string; stacks: string[]; commands: Record<string, string>; initFingerprint?: string; };
  conventions: string[];
  facts: MemoryFact[];
  agentState: { lastCwd?: string | null; lastSessionAt?: number | null; turns: number; };
}

export function memoryDirName(): string {
  return STORAGE.PROJECT_DIR;
}

export function memoryDir(root: string): string {
  return path.join(root, memoryDirName());
}

export function memoryFile(root: string) {
  return path.join(memoryDir(root), STORAGE.MEMORY_FILE);
}

export function conventionsFile(root: string) {
  return path.join(memoryDir(root), STORAGE.CONVENTIONS_FILE);
}

export function claudeMdFile(root: string) {
  return path.join(root, 'OLLAMACODE.md');
}


export function findProjectDoc(root: string, from: string = root): string | null {
  const stop = path.resolve(root);
  let probe = path.resolve(from || root);

  for (;;) {
    const candidate = claudeMdFile(probe);
    try {
      // A directory named OLLAMACODE.md is not a doc; `existsSync` called it one.
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Unreadable or absent — keep walking.
    }
    if (probe === stop || probe.length <= stop.length) break;
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  return null;
}


export function projectDocStamp(file: string | null): string {
  if (!file) return '';
  try {
    const st = fs.statSync(file);
    return `${file}:${st.mtimeMs}:${st.size}`;
  } catch {
    return '';
  }
}

function defaultMemory(name: string = ''): ProjectMemory {
  return {
    version: MEMORY_VERSION,
    updatedAt: Date.now(),
    project: { name: name || '', stacks: [], commands: {}, initFingerprint: '' },
    conventions: [],
    facts: [],
    agentState: { lastCwd: null, lastSessionAt: null, turns: 0 },
  };
}

function normalize(parsed: any, name: string = ''): ProjectMemory {
  const base = defaultMemory(name);
  if (!parsed || typeof parsed !== 'object') return base;
  return {
    version: typeof parsed.version === 'number' ? parsed.version : base.version,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : base.updatedAt,
    project: {
      name: typeof parsed.project?.name === 'string' ? parsed.project.name : base.project.name,
      stacks: Array.isArray(parsed.project?.stacks)
        ? parsed.project.stacks.filter((s: unknown) => typeof s === 'string')
        : [],
      commands:
        parsed.project?.commands && typeof parsed.project.commands === 'object'
          ? (Object.fromEntries(
              Object.entries(parsed.project.commands).filter(
                ([k, v]: [string, unknown]) => typeof k === 'string' && typeof v === 'string'
              )
            ) as Record<string, string>)
          : {},
      initFingerprint:
        typeof parsed.project?.initFingerprint === 'string' ? parsed.project.initFingerprint : '',
    },
    conventions: Array.isArray(parsed.conventions)
      ? parsed.conventions.filter((c: unknown) => typeof c === 'string' && c.trim()).map((c: string) => c.trim())
      : [],
    facts: Array.isArray(parsed.facts)
      ? parsed.facts
          .filter((f: unknown) => f && typeof (f as { text?: unknown; }).text === 'string' && (f as { text: string; }).text.trim())
          .map((f: { text: string; createdAt?: number; source?: string; }) => ({
            text: String(f.text).trim(),
            createdAt: typeof f.createdAt === 'number' ? f.createdAt : Date.now(),
            source: f.source === 'agent' ? 'agent' : 'user',
          }))
      : [],
    agentState: {
      lastCwd: typeof parsed.agentState?.lastCwd === 'string' ? parsed.agentState.lastCwd : null,
      lastSessionAt:
        typeof parsed.agentState?.lastSessionAt === 'number' ? parsed.agentState.lastSessionAt : null,
      turns: typeof parsed.agentState?.turns === 'number' ? parsed.agentState.turns : 0,
    },
  };
}

export function loadMemory(root: string): ProjectMemory {
  try {
    const raw = fs.readFileSync(memoryFile(root), 'utf-8');
    const name = path.basename(root);
    return normalize(JSON.parse(raw), name);
  } catch {
    return defaultMemory(path.basename(root));
  }
}

function hasMemory(root: string) {
  try {
    return fs.statSync(memoryFile(root)).isFile();
  } catch {
    return false;
  }
}

function saveMemory(root: string, mem: ProjectMemory): ProjectMemory {
  const file = memoryFile(root);
  const next = { ...mem, updatedAt: Date.now() };
  writeJsonAtomic(file, next);
  return next;
}

export function updateMemory(root: string, mutator: (mem: ProjectMemory) => void): ProjectMemory {
  const mem = loadMemory(root);
  mutator(mem);
  mem.conventions = mem.conventions.slice(0, MAX_CONVENTIONS);
  mem.facts = mem.facts.slice(-MAX_FACTS);
  return saveMemory(root, mem);
}

export function parseConventionsFile(root: string): string[] {
  let raw = '';
  try {
    raw = fs.readFileSync(conventionsFile(root), 'utf-8');
  } catch {
    return [];
  }
  const body = raw.replace(/<!--[\s\S]*?-->/g, '');
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    out.push(t.replace(/^[-*+]\s+/, '').trim());
  }
  return out.filter(Boolean);
}

function writeConventionsTemplate(root: string): boolean {
  const file = conventionsFile(root);
  if (fs.existsSync(file)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      '# Project conventions',
      '',
      '<!--',
      'How ocode should work in this repository. One convention per line, starting',
      'with "- ". Lines starting with # are ignored; this comment is too.',
      'Edit freely — changes are picked up next session.',
      '',
      'Examples:',
      '- Prefer editing existing files over creating new ones',
      '- Run the full test suite before declaring work done',
      '- Never commit directly to main',
      '-->',
      '',
    ].join('\n')
  );
  return true;
}

export function representativeCommands(stacks: Array<{ label?: string; test?: string[]; build?: string[]; lint?: string[]; run?: string[]; dev?: string[]; }> = []): Record<string, string> {
  const commands: Record<string, string> = {};
  for (const verb of ['test', 'build', 'lint', 'run', 'dev'] as const) {
    const found = stacks.find((s) => Array.isArray(s[verb]) && s[verb].length > 0);
    if (found) commands[verb] = (found[verb] ?? []).join(' ');
  }
  return commands;
}

const PROJECT_MANIFESTS = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
]);

function projectManifestPaths(root: string): string[] {
  const found: string[] = [];
  const ignored = new Set(['.git', '.ollamacode', 'node_modules', 'bin', 'obj', 'dist', 'build', '.venv', 'venv']);
  const walk = (dir: string, depth: number) => {
    if (depth < 0) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.env') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignored.has(entry.name)) walk(full, depth - 1);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (
        PROJECT_MANIFESTS.has(lower) ||
        /\.(?:sln|slnx|csproj|fsproj|vbproj)$/i.test(entry.name)
      ) {
        found.push(path.relative(root, full).replaceAll(path.sep, '/'));
      }
    }
  };
  walk(root, 4);
  return found.sort();
}

export function projectFingerprint(
  stacks: Array<{ label?: string; test?: string[]; build?: string[]; lint?: string[]; run?: string[]; dev?: string[]; }> = [],
  root?: string,
): string {
  const labels = [...new Set(stacks.map((s) => s.label).filter(Boolean))].sort();
  return JSON.stringify({
    labels,
    commands: representativeCommands(stacks),
    manifests: root ? projectManifestPaths(root) : [],
  });
}

export function seedMemoryFromStacks(root: string, stacks: Array<{ label?: string; test?: string[]; build?: string[]; lint?: string[]; run?: string[]; dev?: string[]; }> = []): { created: boolean; mem: ProjectMemory; } {
  const existed = hasMemory(root);
  const mem = loadMemory(root);
  const created = !existed;

  mem.project.name ||= path.basename(root);
  mem.project.stacks = [...new Set(stacks.map((s) => s.label).filter((l) => typeof l === 'string'))];
  mem.project.commands = stacks.length
    ? { ...mem.project.commands, ...representativeCommands(stacks) }
    : {};
  if (!existed) writeConventionsTemplate(root);
  return { created, mem: saveMemory(root, mem) };
}

export function ensureMemory(root: string, stacks: any[] = []): ProjectMemory | null {
  try {
    return seedMemoryFromStacks(root, stacks).mem;
  } catch {
    return null;
  }
}

export function recordSessionState(root: string, { cwd = null, turns = 0 }: any = {}): ProjectMemory | null {
  try {
    return updateMemory(root, (mem) => {
      if (cwd !== undefined && cwd !== null) mem.agentState.lastCwd = cwd;
      mem.agentState.lastSessionAt = Date.now();
      mem.agentState.turns += Math.max(0, Number(turns) || 0);
    });
  } catch {
    return null;
  }
}

export function addFact(mem: ProjectMemory, text: string, source: 'user' | 'agent' = 'user') {
  const t = String(text ?? '').trim().slice(0, 500);
  if (!t) return false;
  const existing = mem.facts.find((f) => f.text.toLowerCase() === t.toLowerCase());
  if (existing) {
    existing.createdAt = Date.now();
    existing.source = source;
  } else {
    mem.facts.push({ text: t, createdAt: Date.now(), source });
    if (mem.facts.length > MAX_FACTS) mem.facts = mem.facts.slice(-MAX_FACTS);
  }
  return true;
}

export function forgetEntry(mem: ProjectMemory, n: number): 'convention' | 'fact' | null {
  const i = Number(n);
  if (!Number.isInteger(i) || i < 1) return null;
  if (i <= mem.conventions.length) {
    mem.conventions.splice(i - 1, 1);
    return 'convention';
  }
  const fi = i - mem.conventions.length - 1;
  if (fi < mem.facts.length) {
    mem.facts.splice(fi, 1);
    return 'fact';
  }
  return null;
}

function ago(ts: number): string {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.max(1, Math.round(hours / 24));
  return `${days}d ago`;
}

export function renderMemoryPrompt(mem: ProjectMemory | null, { extraConventions = [], maxChars = 1600 }: any = {}): string {
  if (!mem) return '';
  const conventions = [...extraConventions, ...mem.conventions].slice(0, MAX_CONVENTIONS);
  const facts = mem.facts.slice(-MAX_FACTS);

  const sections: any[] = [];
  if (conventions.length) {
    sections.push(`Conventions:\n${conventions.map((c) => `- ${c}`).join('\n')}`);
  }
  if (facts.length) {
    sections.push(`Facts:\n${facts.map((f) => `- ${f.text}`).join('\n')}`);
  }


  if (!sections.length) return '';

  const header = MEMORY_BLOCK_HEADER;
  const body = `${header}\n${sections.join('\n')}`;
  if (body.length <= maxChars) return body;

  const priority = ['Conventions:', 'Facts:'];
  let parts = [header];
  const bySection = new Map(sections.map((s) => [s.match(/^[^:\n]+:/)?.[0], s]));
  const kept: any[] = [];
  for (const key of priority) {
    const s = bySection.get(key);
    if (s) kept.push(s); // preserve original order: conventions, then facts
    if ([header, ...kept].join('\n').length <= maxChars) parts = [header, ...kept];
  }
  let out = parts.join('\n');
  while (out.length > maxChars && kept.length) {
    const target = kept[0];
    const lines = target.split('\n');
    const trimmed = lines.slice(0, -1).join('\n');
    if (trimmed.split('\n').length <= 1) kept.shift();
    else kept[0] = trimmed;
    out = [header, ...kept].join('\n');
  }
  return out.length <= maxChars ? out : '';
}

export function summarizeMemory(mem: ProjectMemory): string {
  const bits = [
    `${mem.conventions.length} convention${mem.conventions.length === 1 ? '' : 's'}`,
    `${mem.facts.length} fact${mem.facts.length === 1 ? '' : 's'}`,
  ];
  if (mem.project.stacks.length) bits.push(`stack: ${mem.project.stacks.join(', ')}`);
  if (mem.agentState.lastSessionAt) bits.push(`last session ${ago(mem.agentState.lastSessionAt)}`);
  return bits.join(' · ');
}
