import { pickRelevant } from '../content/relevance';
import { clamp } from '../core/tool-result';
import type { DocSection, ParsedDocument } from './types';

interface DocumentView {
  query?: string;
  pages?: string;
  sheet?: string;
  maxChars: number;
}

type ViewResult = { ok: true; text: string; truncated: boolean } | { ok: false; error: string };

const PREVIEW_ROWS = 5;
const FOOTER_RESERVE = 200;
const CONTENTS_LINE = 90;

function sep(doc: ParsedDocument): string {
  return doc.unit === 'sheet' ? '\n' : '\n\n';
}

function headline(doc: ParsedDocument, name: string): string {
  const n = doc.sections.length;
  const parts = [`${name} — ${doc.format}, ${n} ${doc.unit}${n === 1 ? '' : 's'}`];
  if (doc.unit === 'sheet') parts.push(`: ${doc.sections.map((s) => s.label).join(', ')}`);
  if (doc.title) parts.push(` — "${doc.title}"`);
  return parts.join('');
}

/** "3", "2-5", "1,4-6" or "7-" as 0-based page indices; a string is the reason the spec is unusable. */
export function parsePages(spec: string, count: number): number[] | string {
  const out = new Set<number>();
  for (const part of String(spec).split(',').map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*(?:-\s*(\d*))?$/.exec(part);
    if (!m) return `"${part}" is not a page or page range (use e.g. "3" or "2-5")`;
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : m[2] === '' ? count : Number(m[2]);
    if (from < 1 || from > count || to < from) return `pages ${part} are outside 1-${count}`;
    for (let p = from; p <= Math.min(to, count); p++) out.add(p - 1);
  }
  return out.size ? [...out].sort((a, b) => a - b) : 'no pages given';
}

function selectSections(doc: ParsedDocument, view: DocumentView): number[] | string | null {
  if (view.pages) {
    if (doc.unit !== 'page') return `This ${doc.format} has sheets, not pages — pass sheet instead.`;
    return parsePages(view.pages, doc.sections.length);
  }
  if (view.sheet) {
    if (doc.unit !== 'sheet') return `This ${doc.format} has pages, not sheets — pass pages instead.`;
    const want = view.sheet.trim().toLowerCase();
    const at = doc.sections.findIndex((s) => s.label.toLowerCase() === want);
    return at >= 0 ? [at] : `No sheet named "${view.sheet}". Sheets: ${doc.sections.map((s) => s.label).join(', ')}.`;
  }
  return null;
}

function heading(s: DocSection): string {
  return [`## ${s.label}${s.summary ? ` (${s.summary})` : ''}`, s.header].filter(Boolean).join('\n');
}

function renderSearch(doc: ParsedDocument, indices: number[], query: string, budget: number): string {
  const flat = indices.flatMap((si) => doc.sections[si].blocks.map((text) => ({ si, text })));
  // Headings and the footer come out of the same budget, so reserve for them before picking passages.
  const headings = Math.min(budget / 4, indices.reduce((n, si) => n + heading(doc.sections[si]).length + 3, 0));
  const { picked, matched, shown } = pickRelevant(flat.map((b) => b.text), query, budget - headings - FOOTER_RESERVE, {
    // A table's column names usually sit in the block above its rows, so a hit brings its neighbours from the same page.
    context: doc.unit === 'page' ? 1 : 0,
    group: (i) => flat[i].si,
  });
  const scope = indices.length === doc.sections.length ? 'the document' : `the selected ${doc.unit}s`;
  if (matched === 0) {
    return `No matches for "${query}" in ${scope}. Try other words, or read a ${doc.unit} directly.`;
  }
  const out: string[] = [];
  let lastSection = -1;
  for (const i of picked) {
    if (flat[i].si !== lastSection) {
      out.push(`\n${heading(doc.sections[flat[i].si])}`);
      lastSection = flat[i].si;
    }
    out.push(flat[i].text);
  }
  const hits = doc.unit === 'sheet' ? 'rows' : 'passages';
  const footer = matched > shown ? `\n\n${matched} matching ${hits}; the best ${shown} are shown. Narrow the query or select a ${doc.unit} for the rest.` : '';
  return `Matches for "${query}":${out.join(doc.unit === 'sheet' ? '\n' : '\n\n')}${footer}`;
}

// Whole sections in order until the budget runs out; the cut point is named so the next call can continue from it.
function renderFull(doc: ParsedDocument, indices: number[], budget: number): { text: string; truncated: boolean } {
  const out: string[] = [];
  let used = 0;
  for (const si of indices) {
    const s = doc.sections[si];
    const head = heading(s);
    out.push(head);
    used += head.length + 2;
    for (let b = 0; b < s.blocks.length; b++) {
      const block = s.blocks[b];
      if (used + block.length > budget) {
        const where = doc.unit === 'sheet' ? `${s.label} at ${block.split(':')[0]}` : `${s.label}, part ${b + 1} of ${s.blocks.length}`;
        out.push(`…[stopped at ${where} to stay within ${budget} characters — use query to find specific content${doc.unit === 'page' ? ', or pages to read further' : ''}]`);
        return { text: out.join(sep(doc)), truncated: true };
      }
      out.push(block);
      used += block.length + 1;
    }
    if (s.blocks.length === 0) out.push('(no text)');
  }
  return { text: out.join(sep(doc)), truncated: false };
}

// Too big to show whole: the opening of a PDF plus a one-line-per-page contents list, or each sheet's columns and first rows.
function renderOverview(doc: ParsedDocument, budget: number): { text: string; truncated: boolean } {
  const out: string[] = [];
  if (doc.unit === 'sheet') {
    for (const s of doc.sections) out.push([heading(s), ...s.blocks.slice(0, PREVIEW_ROWS)].join('\n'));
  } else {
    const opening = renderFull(doc, [0], Math.floor(budget / 3)).text;
    out.push(opening, '## Contents');
    for (const s of doc.sections) {
      const first = (s.blocks[0] ?? '(no text)').replace(/\s+/g, ' ');
      out.push(`${s.label}: ${first.length > CONTENTS_LINE ? `${first.slice(0, CONTENTS_LINE - 1)}…` : first}`);
    }
  }
  const how = doc.unit === 'sheet' ? 'pass query to find rows, or sheet to read one sheet' : 'pass query to search it, or pages (e.g. "4-6") to read a range';
  const trailer = `\n\nThis is an overview — ${how}.`;
  const room = budget - trailer.length - 2;
  let text = out.join(doc.unit === 'sheet' ? '\n\n' : '\n');
  const truncated = text.length > room;
  if (truncated) text = `${text.slice(0, room)}\n…`;
  return { text: `${text}${trailer}`, truncated };
}

/** The part of a parsed document a call asked for, within `maxChars`. */
export function renderDocument(doc: ParsedDocument, name: string, view: DocumentView): ViewResult {
  const chosen = selectSections(doc, view);
  if (typeof chosen === 'string') return { ok: false, error: chosen };
  const indices = chosen ?? doc.sections.map((_, i) => i);
  const top = [headline(doc, name), doc.note].filter(Boolean).join('\n');
  const budget = Math.max(500, view.maxChars - top.length);
  const query = view.query?.trim();

  const total = indices.reduce((n, si) => n + doc.sections[si].blocks.reduce((m, b) => m + b.length + 1, 0), 0);
  const body = query
    ? { text: renderSearch(doc, indices, query, budget), truncated: false }
    : chosen || total <= budget
      ? renderFull(doc, indices, budget)
      : renderOverview(doc, budget);
  // maxChars is a hard limit: the agent cuts anything longer out of the middle, which loses more than a clean cut here.
  const { text, truncated } = clamp(`${top}\n\n${body.text}`, view.maxChars);
  return { ok: true, text, truncated: truncated || body.truncated };
}
