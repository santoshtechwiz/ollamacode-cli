// Query-driven passage selection. BM25 weighting makes words common across the document count for little, so no stopword list is needed.

const K1 = 1.2;
const B = 0.75;
const WORD = /[\p{L}\p{N}]+/gu;

function words(text: string): string[] {
  return String(text ?? '').toLowerCase().match(WORD) ?? [];
}

/** Distinct query words worth matching; single characters carry no signal. */
function queryTerms(query: string): string[] {
  return [...new Set(words(query).filter((w) => w.length > 1))];
}

// A term of four or more letters also matches its inflections ("invoice" → "invoices").
function matches(token: string, term: string): boolean {
  return token === term || (term.length >= 4 && token.startsWith(term) && token.length - term.length <= 3);
}

/** Share of the query's terms that appear in `text`, 0..1. */
export function termCoverage(text: string, query: string): number {
  const terms = queryTerms(query);
  if (terms.length === 0) return 0;
  const tokens = words(text);
  return terms.filter((term) => tokens.some((t) => matches(t, term))).length / terms.length;
}

/** One BM25 score per block; zero means the block shares no term with the query. */
export function scoreBlocks(blocks: string[], query: string): number[] {
  const terms = queryTerms(query);
  if (terms.length === 0 || blocks.length === 0) return blocks.map(() => 0);
  const docs = blocks.map(words);
  const avgLen = docs.reduce((n, d) => n + d.length, 0) / docs.length || 1;
  const tf = docs.map((d) => terms.map((term) => d.filter((t) => matches(t, term)).length));
  const idf = terms.map((_, j) => {
    const df = tf.filter((row) => row[j] > 0).length;
    return Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
  });
  const phrase = terms.length > 1 ? terms.join(' ') : '';
  return docs.map((d, i) => {
    let score = 0;
    terms.forEach((_, j) => {
      const f = tf[i][j];
      if (f > 0) score += idf[j] * ((f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.length) / avgLen)));
    });
    return phrase && d.join(' ').includes(phrase) ? score * 1.5 : score;
  });
}

/** The best-scoring blocks (plus `context` neighbours each side, within the same `group`) that fit in `budget` chars, in document order. */
export function pickRelevant(
  blocks: string[],
  query: string,
  budget: number,
  { context = 0, group }: { context?: number; group?: (i: number) => unknown } = {},
): { picked: number[]; matched: number; shown: number } {
  const scores = scoreBlocks(blocks, query);
  const ranked = scores.map((score, index) => ({ score, index })).filter((s) => s.score > 0).sort((a, b) => b.score - a.score);
  const picked = new Set<number>();
  let used = 0;
  for (const { index } of ranked) {
    const window: number[] = [];
    for (let i = Math.max(0, index - context); i <= Math.min(blocks.length - 1, index + context); i++) {
      if (!picked.has(i) && (i === index || !group || group(i) === group(index))) window.push(i);
    }
    const cost = window.reduce((n, i) => n + blocks[i].length + 2, 0);
    if (used + cost > budget) {
      // The hit alone may still fit where its neighbours did not.
      if (!picked.has(index) && used + blocks[index].length + 2 <= budget) {
        picked.add(index);
        used += blocks[index].length + 2;
      }
      continue;
    }
    for (const i of window) picked.add(i);
    used += cost;
  }
  const shown = ranked.filter((r) => picked.has(r.index)).length;
  return { picked: [...picked].sort((a, b) => a - b), matched: ranked.length, shown };
}

/** Markdown split into paragraph blocks, each heading kept with the paragraph under it. */
export function markdownBlocks(markdown: string): string[] {
  const out: string[] = [];
  let heading = '';
  for (const raw of String(markdown ?? '').split(/\n{2,}/)) {
    const block = raw.trim();
    if (!block) continue;
    if (/^#{1,6}\s/.test(block) && !block.includes('\n')) {
      if (heading) out.push(heading);
      heading = block;
      continue;
    }
    out.push(heading ? `${heading}\n${block}` : block);
    heading = '';
  }
  if (heading) out.push(heading);
  return out;
}

/** Join picked blocks in order, marking skipped stretches so the reader knows text was left out. */
export function joinPicked(blocks: string[], picked: number[]): string {
  const parts: string[] = [];
  let last = -1;
  for (const i of picked) {
    if (i > last + 1) parts.push('…');
    parts.push(blocks[i]);
    last = i;
  }
  if (last < blocks.length - 1) parts.push('…');
  return parts.join('\n\n');
}
