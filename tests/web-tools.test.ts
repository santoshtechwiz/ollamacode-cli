import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import * as XLSX from 'xlsx';

import { TtlCache } from '../src/tool/content/cache';
import { htmlToMarkdown } from '../src/tool/content/html';
import { joinPicked, markdownBlocks, pickRelevant, scoreBlocks } from '../src/tool/content/relevance';
import { readerFor } from '../src/tool/document/readers/index';
import { renderDocument, parsePages } from '../src/tool/document/view';
import readDocument from '../src/tool/document/read-document.tool';
import { keywordsOf, understand } from '../src/tool/web/intent';
import { bingNews } from '../src/tool/web/providers/news';
import { formatResults, rankHits, searchWeb, urlKey, type SearchOutcome } from '../src/tool/web/search';
import { ProviderError, type SearchHit, type SearchProvider } from '../src/tool/web/types';

function hit(url: string, title = `Title for ${url}`, snippet = 'snippet'): SearchHit {
  return { source: 'Test', title, url, snippet, freshness: 'cached' };
}

function provider(id: string, weight: number, run: (signal: AbortSignal) => Promise<SearchHit[]>): SearchProvider & { calls: number } {
  const p = {
    id,
    calls: 0,
    weight: () => weight,
    search: (_intent: unknown, _limit: number, signal: AbortSignal) => {
      p.calls++;
      return run(signal);
    },
  };
  return p;
}

// Resolves after `ms`, or rejects as soon as the signal aborts, like a real fetch.
function after<T>(ms: number, value: T, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(value), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

// A minimal but valid PDF with one text line per page line, built with a correct xref table.
function makePdf(pages: string[]): Buffer {
  const objs = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`];
  const fontId = 3 + pages.length * 2;
  pages.forEach((text, i) => {
    const stream = text.split('\n').map((l, j) => `BT /F1 12 Tf 72 ${720 - j * 16} Td (${l}) Tj ET`).join('\n');
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}

function makeWorkbook(sheets: Record<string, unknown[][]>, bookType: XLSX.BookType = 'xlsx'): Buffer {
  const book = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(book, { type: 'buffer', bookType });
}

describe('TtlCache', () => {
  it('expires entries and evicts the least recently used', () => {
    let now = 0;
    const cache = new TtlCache<string>(2, () => now);
    cache.set('a', 'A', 100);
    cache.set('b', 'B', 100);
    assert.equal(cache.get('a'), 'A'); // a is now the most recent
    cache.set('c', 'C', 100);
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.get('a'), 'A');
    now = 150;
    assert.equal(cache.get('c'), undefined);
  });
});

describe('relevance', () => {
  it('ranks the block about the query first without a stopword list', () => {
    const blocks = ['the cat sat on the mat', 'the invoice total is 42 dollars', 'the weather is nice'];
    const scores = scoreBlocks(blocks, 'what is the invoice total');
    assert.equal(scores.indexOf(Math.max(...scores)), 1);
  });

  it('matches inflections and keeps picks within budget and in order', () => {
    const blocks = ['intro', 'invoices are due monthly', 'filler '.repeat(50), 'late invoice fees apply'];
    const { picked, matched } = pickRelevant(blocks, 'invoice', 60);
    assert.equal(matched, 2);
    assert.deepEqual(picked, [1, 3]);
    assert.equal(joinPicked(blocks, picked), '…\n\ninvoices are due monthly\n\n…\n\nlate invoice fees apply');
  });

  it('keeps a heading with the paragraph under it', () => {
    assert.deepEqual(markdownBlocks('# Setup\n\nRun npm install.\n\nMore text.'), ['# Setup\nRun npm install.', 'More text.']);
  });

  it('extracts the main content from HTML', () => {
    const md = htmlToMarkdown(`<html><body><nav>menu</nav><main><h1>Docs</h1><p>${'Real content. '.repeat(50)}</p><script>x()</script></main></body></html>`);
    assert.ok(md.startsWith('# Docs'));
    assert.ok(!md.includes('menu') && !md.includes('x()'));
  });
});

describe('web search orchestration', () => {
  it('runs providers in parallel and a slow one cannot block the rest', async () => {
    const fast = provider('fast', 1, async () => [hit('https://a.example/1')]);
    const slow = provider('slow', 1, (signal) => after(10_000, [hit('https://b.example/1')], signal));
    const started = Date.now();
    const out = await searchWeb('anything', { limit: 5, providers: [fast, slow], timeoutMs: 100, cache: null });
    assert.ok(Date.now() - started < 1_000);
    assert.deepEqual(out.results.map((r) => r.url), ['https://a.example/1']);
    assert.deepEqual(out.failures.map((f) => [f.provider, f.kind]), [['slow', 'timeout']]);
  });

  it('stops waiting for slower primaries a grace period after the first answer', async () => {
    const fast = provider('fast', 1, async () => [hit('https://a.example/1')]);
    const slow = provider('slow', 0.9, (signal) => after(10_000, [hit('https://b.example/1')], signal));
    const started = Date.now();
    const out = await searchWeb('anything', { limit: 5, providers: [fast, slow], timeoutMs: 20_000, graceMs: 50, cache: null });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(out.results.length, 1);
  });

  it('keeps partial results when a provider fails and classifies the failure', async () => {
    const good = provider('good', 1, async () => [hit('https://a.example/')]);
    const bad = provider('bad', 1, async () => {
      throw new ProviderError('bad', 'rate-limited', 'bad: rate-limited');
    });
    const out = await searchWeb('x', { limit: 5, providers: [good, bad], cache: null });
    assert.equal(out.results.length, 1);
    assert.equal(out.failures[0].kind, 'rate-limited');
  });

  it('cancels fallbacks once a primary answered, and uses them when primaries are empty', async () => {
    const primary = provider('primary', 1, async () => [hit('https://p.example/')]);
    const fallback = provider('fallback', 0.2, (signal) => after(5_000, [hit('https://f.example/')], signal));
    const out = await searchWeb('q', { limit: 5, providers: [primary, fallback], cache: null });
    assert.deepEqual(out.results.map((r) => r.url), ['https://p.example/']);
    assert.deepEqual(out.failures, []);

    const empty = provider('primary', 1, async () => []);
    const backup = provider('fallback', 0.2, async () => [hit('https://f.example/')]);
    const second = await searchWeb('q', { limit: 5, providers: [empty, backup], cache: null });
    assert.deepEqual(second.results.map((r) => r.url), ['https://f.example/']);
  });

  it('never asks a provider whose weight is zero', async () => {
    const skipped = provider('skipped', 0, async () => [hit('https://s.example/')]);
    const used = provider('used', 1, async () => [hit('https://u.example/')]);
    await searchWeb('q', { limit: 5, providers: [skipped, used], cache: null });
    assert.equal(skipped.calls, 0);
  });

  it('caches a successful search', async () => {
    const p = provider('p', 1, async () => [hit('https://a.example/')]);
    const cache = new TtlCache<SearchOutcome>(4);
    await searchWeb('Same  Query', { limit: 5, providers: [p], cache });
    await searchWeb('same query', { limit: 5, providers: [p], cache });
    assert.equal(p.calls, 1);
  });

  it('merges duplicate URLs and titles and rewards agreement', () => {
    const ranked = rankHits([
      { weight: 1, hits: [hit('https://only.example/x', 'Unrelated page'), hit('http://www.shared.example/doc/?utm_source=a#top', 'Shared article about rust release', 'short')] },
      { weight: 1, hits: [hit('https://shared.example/doc', 'Other title', 'a much longer snippet')] },
      { weight: 1, hits: [hit('https://mirror.example/copy', 'Shared article about rust release')] },
    ], 'rust release', 10);
    assert.equal(ranked.length, 1); // "Unrelated page" shares no query word with the best hit, so it is dropped
    assert.equal(ranked[0].url, 'http://www.shared.example/doc/?utm_source=a#top');
    assert.equal(ranked[0].snippet, 'a much longer snippet');
  });

  it('puts fresh hits first for a question about now', () => {
    const now = Date.parse('2026-09-29T00:00:00Z');
    const old = { ...hit('https://old.example/'), publishedAt: '2026-07-01T00:00:00Z' };
    const fresh = { ...hit('https://fresh.example/'), publishedAt: '2026-09-28T20:00:00Z' };
    const batches = [{ weight: 1, hits: [old] }, { weight: 1, hits: [hit('https://x.example/'), fresh] }];
    assert.equal(rankHits(batches, 'q', 5, true, now)[0].url, 'https://fresh.example/');
    assert.equal(rankHits(batches, 'q', 5, false, now)[0].url, 'https://old.example/');
  });

  it('normalizes URLs for dedupe', () => {
    assert.equal(urlKey('https://www.Example.com/a/?utm_medium=x&b=2&a=1#frag'), urlKey('http://example.com/a?a=1&b=2'));
  });

  it('states each source caveat once', () => {
    const results = [0, 1].map((i) => ({ ...hit(`https://w.example/${i}`), source: 'Wikipedia', delayNote: 'encyclopedia article' }));
    const text = formatResults(results);
    assert.equal(text.split('encyclopedia article').length - 1, 1);
  });

  it('parses Bing News RSS into real article URLs, searching by topic', async () => {
    const rss = '<rss><channel><item><title>Rust 2.0 &amp; more</title>' +
      '<link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;url=https%3a%2f%2fexample.com%2frust&amp;c=1</link>' +
      '<description>The Rust team announced...</description><pubDate>Mon, 28 Sep 2026 13:07:00 GMT</pubDate>' +
      '<News:Source>Example</News:Source></item></channel></rss>';
    const realFetch = globalThis.fetch;
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(new URL(String(url)).search.match(/q=([^&]*)/)![1]);
      return new Response(rss, { status: 200 });
    }) as typeof fetch;
    try {
      const hits = await bingNews.search(understand('latest news about Rust'), 5, new AbortController().signal);
      assert.deepEqual(asked.sort(), ['latest%20news%20about%20Rust', 'news%20about%20Rust']); // as written and without the recency word, together
      assert.deepEqual(hits.map((h) => [h.title, h.url, h.source, h.publishedAt]), [
        ['Rust 2.0 & more', 'https://example.com/rust', 'Bing News (Example)', '2026-09-28T13:07:00.000Z'],
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('routes by intent', () => {
    assert.deepEqual(understand('$NVDA stock price').tickers, ['NVDA']);
    assert.deepEqual(understand('apple pie recipe').tickers, []);
    assert.deepEqual(understand('EUR to USD rate').fx, { from: 'EUR', to: 'USD' });
    assert.deepEqual(understand('will it rain in London tomorrow').places, ['London tomorrow', 'London']);
    assert.equal(understand('latest news about the Rust language?').topic, 'news about the Rust language');
    const dated = understand('Malaysia news September 29 2026 site:malaymail.com OR site:thestar.com.my');
    assert.equal(dated.topic, 'Malaysia news site:malaymail.com OR site:thestar.com.my');
    assert.equal(keywordsOf(dated), 'Malaysia');
    assert.equal(understand('Malay Mail "Sept 29" Malaysia').recent, true);
    assert.equal(understand('python 3.14 release').recent, false);
  });
});

describe('documents', () => {
  it('picks a reader by extension or content type', () => {
    assert.equal(readerFor('a/Report.PDF')?.format, 'PDF');
    assert.equal(readerFor('book.xls')?.format, 'spreadsheet');
    assert.equal(readerFor('https://x.example/get?id=1', 'application/pdf')?.format, 'PDF');
    assert.equal(readerFor('notes.txt'), undefined);
  });

  it('reads PDF pages and finds matches with their page', async () => {
    const doc = await readerFor('a.pdf')!.read(makePdf(['Welcome to the guide', 'Invoice total is 42 dollars', 'Appendix']));
    assert.equal(doc.sections.length, 3);
    const view = renderDocument(doc, 'a.pdf', { query: 'invoice total', maxChars: 2000 });
    assert.ok(view.ok && view.text.includes('## Page 2') && view.text.includes('Invoice total is 42'));
    assert.ok(view.ok && !view.text.includes('Appendix'));
    const page = renderDocument(doc, 'a.pdf', { pages: '3', maxChars: 2000 });
    assert.ok(page.ok && page.text.includes('Appendix') && !page.text.includes('Welcome'));
  });

  it('reads xlsx and xls rows against their header with real row numbers', async () => {
    for (const type of ['xlsx', 'biff8'] as const) {
      const bytes = makeWorkbook({ Sales: [['Name', 'Amount'], ['Bob', 12], [], ['Ann', 7]], Empty: [] }, type);
      const doc = await readerFor('b.xlsx')!.read(bytes);
      assert.deepEqual(doc.sections[0].blocks, ['row 2: Name=Bob | Amount=12', 'row 4: Name=Ann | Amount=7']);
      const view = renderDocument(doc, 'b.xlsx', { query: 'ann', maxChars: 2000 });
      assert.ok(view.ok && view.text.includes('columns: Name | Amount') && view.text.includes('row 4') && !view.text.includes('Bob'));
    }
  });

  it('gives an overview instead of the whole of a large document', async () => {
    const pages = Array.from({ length: 30 }, (_, i) => `Page ${i + 1} heading\n${'Lorem ipsum dolor sit amet. '.repeat(20)}`);
    const doc = await readerFor('big.pdf')!.read(makePdf(pages));
    const view = renderDocument(doc, 'big.pdf', { maxChars: 3000 });
    assert.ok(view.ok && view.text.length < 3600 && view.text.includes('## Contents') && view.text.includes('overview'));
  });

  it('reports bad page ranges and unknown sheets instead of guessing', () => {
    assert.equal(typeof parsePages('9', 3), 'string');
    assert.deepEqual(parsePages('1,3-', 4), [0, 2, 3]);
    const doc = { format: 'spreadsheet', unit: 'sheet' as const, sections: [{ label: 'Sales', blocks: [] }] };
    const view = renderDocument(doc, 'b.xlsx', { sheet: 'Costs', maxChars: 1000 });
    assert.ok(!view.ok && view.error.includes('Sheets: Sales'));
  });

  it('read_document refuses unsupported and corrupt files cleanly', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'read-doc-'));
    const ctx = { ws: { rel: (p: string) => path.basename(p) } } as any;
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    fs.writeFileSync(path.join(dir, 'broken.pdf'), 'not a pdf');
    fs.writeFileSync(path.join(dir, 'ok.xlsx'), makeWorkbook({ Sheet1: [['A'], ['x']] }));
    const unsupported = await readDocument.execute({ path: path.join(dir, 'notes.txt') }, ctx);
    assert.equal(unsupported.ok, false);
    assert.ok(unsupported.hint?.includes('.pdf'));
    const broken = await readDocument.execute({ path: path.join(dir, 'broken.pdf') }, ctx);
    assert.equal(broken.ok, false);
    const good = await readDocument.execute({ path: path.join(dir, 'ok.xlsx') }, ctx);
    assert.ok(good.ok && good.display?.includes('row 2: A=x'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
