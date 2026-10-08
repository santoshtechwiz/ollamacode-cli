import fs from 'node:fs/promises';
import path from 'node:path';

import { runtime } from '../tool/execution/runtime';
import { createWorkspace } from '../agent/workspace/manager';
import { logger } from '../core/logger';
import { findProjectDoc } from './memory';
import { relSlash } from './workspace-index/_shared';
import type { IndexHandle } from './workspace-index/_shared';
import { LANGUAGES } from '../env/languages';

const MAX_FILE_CHARS = 3000;
const WRAPPER_CHARS = '[Auto-context]\n\n[/Auto-context]'.length;
const MAX_TOTAL_CHARS = 6000;
/** Cap on the index-derived project map; it is best-effort, last in the block. */
const PROJECT_MAP_BUDGET = 1200;

/** The share of the budget reserved for the project doc before anything else spends it. */
const DOC_SHARE = 0.6;

/** Closes a fence the truncation cut open. */
const FENCE_CLOSE = '\n```';

// Each language's primary manifest, plus the readme.
const KEY_FILES = [...LANGUAGES.flatMap((l) => l.markers?.slice(0, 1) ?? []), 'README.md'];

interface GatherOptions {
  signal?: AbortSignal;
  maxChars?: number;

  projectDoc?: string | null;

  index?: IndexHandle | null;
}


async function readProjectDoc(file: string, budget: number): Promise<string | null> {
  if (budget <= 0) return null;
  let raw = '';
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch (err) {
    logger.debug(`auto-context: project doc unreadable (${(err as Error).message})`);
    return null;
  }
  const text = raw.replace(/^\uFEFF/, '').trim();
  if (!text) return null;
  if (text.length <= budget) return text;

  const marker = `\n…[${path.basename(file)} truncated here — read the file for the rest]`;
  const room = budget - marker.length - FENCE_CLOSE.length;
  if (room <= 0) return null;

  let kept = text.slice(0, room);
  // Cut at a line boundary rather than mid-word, unless that would throw most of the allowance away.
  const lastBreak = kept.lastIndexOf('\n');
  if (lastBreak > room / 2) kept = kept.slice(0, lastBreak);
  // A doc cut inside a code fence leaves it open, so everything after it would read as code.
  if ((kept.match(/^```/gm) ?? []).length % 2 === 1) kept += FENCE_CLOSE;
  return `${kept}${marker}`;
}


function renderProjectMap(index: IndexHandle, workspaceRoot: string, budget: number): string | null {
  if (budget <= 0) return null;
  let rows: any[];
  try {
    rows = index.db
      .prepare(
        `SELECT p.root AS root, p.name AS name, p.marker AS marker, p.stacks_json AS json,
                (SELECT COUNT(*) FROM files f WHERE f.project_id = p.id) AS files,
                (SELECT COUNT(*) FROM symbols s WHERE s.project_id = p.id) AS symbols
         FROM projects p
         ORDER BY (p.root = ?) DESC, p.name
         LIMIT 10`
      )
      .all(workspaceRoot);
  } catch (err) {
    logger.debug(`auto-context: project map unavailable (${(err as Error).message})`);
    return null;
  }
  if (!rows.length) return null;

  const lines: string[] = [];
  for (const r of rows) {
    let labels: string[] = [];
    try {
      labels = (JSON.parse(r.json ?? '[]') as Array<{ label?: string; }>).map((s) => s.label).filter((v): v is string => Boolean(v));
    } catch { /* not a stacks blob */ }
    const rel = relSlash(workspaceRoot, r.root);
    const meta = [...labels, r.marker].filter(Boolean).join(', ');
    lines.push(`- ${r.name}${meta ? ` (${meta})` : ''} @ ${rel} — ${r.files} files, ${r.symbols} symbols`);
  }
  const body = lines.join('\n');
  if (body.length <= budget) return body;
  const room = Math.max(0, budget - 2);
  return `${body.slice(0, room)}…`;
}

export async function gatherContext(
  cwd: string,
  { signal, maxChars = MAX_TOTAL_CHARS, projectDoc, index }: GatherOptions = {}
): Promise<string> {
  const ctx = { cwd, root: cwd, ws: createWorkspace({ root: cwd }), signal };
  const asked = Math.max(500, Number(maxChars) || MAX_TOTAL_CHARS);
  const parts: string[] = [];

  const noApprove = async () => false;


  let budget = asked - WRAPPER_CHARS;

  const spend = (label: string, body: string) => {
    parts.push(`${label}:\n${body}`);
    budget -= body.length + label.length + 4;
  };

  const docFile = projectDoc === undefined ? findProjectDoc(cwd) : projectDoc;
  if (docFile) {
    const doc = await readProjectDoc(docFile, Math.floor(budget * DOC_SHARE));
    if (doc) spend('OLLAMACODE.md', doc);
  }

  const reads = await Promise.allSettled(
    KEY_FILES.map((f) => runtime.run('read_file', { path: f }, ctx, noApprove))
  );

  for (let i = 0; i < reads.length; i++) {
    if (budget <= 0) break;
    const settled = reads[i];
    if (settled.status !== 'fulfilled') continue;
    const result = settled.value;
    // The file's own text: the display numbers every line, which only spends the budget on gutters.
    const content = (result.data as { fullContent?: unknown } | undefined)?.fullContent;
    const text = typeof content === 'string' ? content : result.display;
    if (!result.ok || !text) continue;

    const label = KEY_FILES[i];
    const room = Math.min(MAX_FILE_CHARS, budget - label.length - 4);
    if (room <= 0) break;
    const body = text.slice(0, room);
    if (!body.trim()) continue;
    spend(label, body);
  }

  if (index?.db && budget > 12) {
    const map = renderProjectMap(index, cwd, Math.min(PROJECT_MAP_BUDGET, budget - 12));
    if (map) spend('Projects', map);
  }

  if (parts.length === 0) return '';

  const block = `[Auto-context]\n${parts.join('\n\n')}\n[/Auto-context]`;
  logger.debug(`auto-context: ${block.length} chars from ${parts.length} sources`);
  return block.length > MAX_TOTAL_CHARS
    ? `${block.slice(0, MAX_TOTAL_CHARS)}\n…[truncated]\n[/Auto-context]`
    : block;
}
