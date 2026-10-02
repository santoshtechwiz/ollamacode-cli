import fsp from 'node:fs/promises';
import path from 'node:path';

import { relTo, SKIP_DIRS, isBinaryFile, walkFiles } from '../tool/filesystem/_fs';
import { createWorkspace } from '../agent/workspace/manager';
import { logger } from '../core/logger';

const MAX_MENTION_BYTES = 12_000;
const MAX_TOTAL_BYTES = 40_000;
const MAX_MENTION_FILES = 10;

const MENTION_RE = /@(?:"([^"\n]+)"|'([^'\n]+)'|([^\s"'`,;()@]+))/g;

function extractMentions(text: string): string[] {
  const re = new RegExp(MENTION_RE.source, 'g');
  const out: any[] = [];
  const seen = new Set();

  for (let m = re.exec(String(text ?? '')); m !== null; m = re.exec(String(text ?? ''))) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (!raw) continue;
    const cleaned = raw.replace(/[.,:;!?]+$/, '');
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

async function resolveMentions(mentions: string[], cwd: string): Promise<string> {
  if (!mentions.length) return '';

  const blocks: any[] = [];
  let used = 0;
  let count = 0;

  for (const mention of mentions) {
    if (count >= MAX_MENTION_FILES || used >= MAX_TOTAL_BYTES) {
      blocks.push(`(${mentions.length - count} further mention(s) omitted to stay within the context budget)`);
      break;
    }
    count += 1;

    if (/[*?[\]]/.test(mention)) {
      const matches = await fuzzyFind(cwd, mention.replace(/[*?[\]]/g, ''), 8);
      blocks.push(
        matches.length
          ? `[@${mention}] matched:\n${matches.join('\n')}`
          : `[@${mention}] no files matched`
      );
      continue;
    }

    let abs;
    try {
      abs = await createWorkspace({ root: cwd }).resolve(mention);
    } catch (err) {
      blocks.push(`[@${mention}] ${ (err as Error).message}`);
      continue;
    }

    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      const matches = await fuzzyFind(cwd, path.basename(mention), 6);
      blocks.push(
        matches.length
          ? `[@${mention}] not found — did you mean:\n${matches.join('\n')}`
          : `[@${mention}] not found`
      );
      continue;
    }

    if (stat.isDirectory()) {
      try {
        const entries = await fsp.readdir(abs, { withFileTypes: true });
        const listing = entries
          .filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
          .map((e) => e.name + (e.isDirectory() ? '/' : ''))
          .join(', ');
        blocks.push(`[@${mention}/] directory:\n${listing.slice(0, 2000)}`);
      } catch (err) {
        blocks.push(`[@${mention}] cannot list: ${ (err as Error).message}`);
      }
      continue;
    }

    if (stat.size > MAX_MENTION_BYTES * 4) {
      blocks.push(
        `[@${mention}] too large (${stat.size} bytes) — use grep_content or read_file with a line range`
      );
      continue;
    }
    if (await isBinaryFile(abs)) {
      blocks.push(`[@${mention}] binary file — skipped`);
      continue;
    }

    try {
      let content = await fsp.readFile(abs, 'utf8');
      const budget = Math.min(MAX_MENTION_BYTES, MAX_TOTAL_BYTES - used);
      if (Buffer.byteLength(content, 'utf8') > budget) {
        content = `${content.slice(0, budget)}\n…[truncated]`;
      }
      used += Buffer.byteLength(content, 'utf8');
      const rel = relTo(cwd, abs);
      blocks.push(`[@${rel}]\n${content}\n[/@${rel}]`);
    } catch (err) {
      blocks.push(`[@${mention}] read error: ${ (err as Error).message}`);
    }
  }

  if (!blocks.length) return '';
  logger.debug(`mentions: ${count} resolved, ${used} bytes`);
  return `[Mentions]\n${blocks.join('\n\n')}\n[/Mentions]`;
}

export async function buildMentionContext(text: string, cwd: string): Promise<{ mentions: string[]; block: string; }> {
  const mentions = extractMentions(text);
  if (!mentions.length) return { mentions, block: '' };
  return { mentions, block: await resolveMentions(mentions, cwd) };
}

function score(rel: string, query: string): number | null {
  if (!query) return rel.length * 0.1;
  const lower = rel.toLowerCase();
  const index = lower.indexOf(query);
  if (index !== -1) return index + rel.length * 0.1;

  let cursor = 0;
  for (const ch of query) {
    cursor = lower.indexOf(ch, cursor);
    if (cursor === -1) return null;
    cursor += 1;
  }
  return 100 + rel.length * 0.1;
}

export async function fuzzyFind(cwd: string, query: string, limit: number = 10): Promise<string[]> {
  const q = String(query ?? '').toLowerCase();
  const results: any[] = [];

  for await (const { rel } of walkFiles(cwd, { maxDepth: 8 })) {
    const s = score(rel, q);
    if (s !== null) results.push({ rel, s });
    if (results.length > 2000) break;
  }
  results.sort((a, b) => a.s - b.s);
  return results.slice(0, limit).map((r) => r.rel);
}

