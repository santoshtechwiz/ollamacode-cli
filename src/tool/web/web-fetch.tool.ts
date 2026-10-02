import path from 'node:path';
import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError, clamp } from '../core/tool-result';
import { withTimeoutSignal } from '../core/timeout-signal';
import { TtlCache } from '../content/cache';
import { htmlToMarkdown, extractTitle } from '../content/html';
import { joinPicked, markdownBlocks, pickRelevant } from '../content/relevance';
import { readerFor } from '../document/readers/index';
import { renderDocument } from '../document/view';
import type { ParsedDocument } from '../document/types';
import { causeChain, isUnreachable } from '../../model/providers/http';
import { fetchPage, type FetchedPage } from './fetch';

// Under the agent's shared per-result limit (8000 by default) so nothing is cut out of the middle.
const DEFAULT_CHARS = 6_000;
const MAX_CHARS = 40_000;
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 10 * 60_000;
const NO_MATCH_PREVIEW = 1_500;

type Extracted = { url: string; title: string; contentType: string } & ({ text: string } | { doc: ParsedDocument });

// A second look at the same URL (another query, a larger max_chars) reads the extracted text, not the network.
const pages = new TtlCache<Extracted>(32);

function looksBinary(bytes: Buffer): boolean {
  return bytes.subarray(0, 1024).includes(0);
}

async function extract(page: FetchedPage): Promise<Extracted | string> {
  const { url, contentType, bytes } = page;
  const reader = readerFor(new URL(url).pathname, contentType);
  if (reader) {
    if (page.clipped) return `The ${reader.format} at ${url} is larger than ${MAX_BYTES / 1048576} MB, too large to read.`;
    return { url, title: '', contentType, doc: await reader.read(new Uint8Array(bytes)) };
  }
  const raw = bytes.toString('utf8');
  if (/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(raw)) {
    return { url, title: extractTitle(raw), contentType, text: htmlToMarkdown(raw) };
  }
  if (/json/i.test(contentType)) {
    try {
      return { url, title: '', contentType, text: JSON.stringify(JSON.parse(raw), null, 2) };
    } catch {
      return { url, title: '', contentType, text: raw };
    }
  }
  if (looksBinary(bytes)) return `${url} is a ${contentType || 'binary'} file, which web_fetch cannot read as text.`;
  return { url, title: '', contentType, text: raw };
}

// With a query only the sections that mention it are returned; with none, the page from the top up to the limit.
function renderText(text: string, query: string | undefined, maxChars: number): { body: string; truncated: boolean } {
  if (query) {
    const blocks = markdownBlocks(text);
    const { picked, matched } = pickRelevant(blocks, query, maxChars - 200, { context: 1 });
    if (matched > 0) return { body: joinPicked(blocks, picked), truncated: picked.length < blocks.length };
    const head = clamp(text, Math.min(maxChars, NO_MATCH_PREVIEW));
    return { body: `Nothing on this page mentions "${query}". It opens with:\n\n${head.text}`, truncated: head.truncated };
  }
  const { text: body, truncated } = clamp(text, maxChars);
  return { body: truncated ? `${body}\n(Pass query to get just the sections you need.)` : body, truncated };
}

export default defineTool({
  name: 'web_fetch',
  aliases: ['browse', 'fetch_url'],
  argAliases: {
    link: 'url',
    href: 'url',
  },
  profiles: ['core'],
  category: 'web',
  activity: 'Fetching a page',
  label: 'Fetch Web Page',
  brief:
    'Read one public http(s) page, JSON resource, PDF or spreadsheet. Pass query to get only the parts about it. Use after web_search or for a user URL.',
  description:
    'Fetch a public web page, text/JSON resource, PDF or spreadsheet over http(s) and return its readable text. Use it when you already have a URL — ' +
    'from a web_search result or from the user; to find one first, use web_search. Pass query with what you are looking for to get only the relevant ' +
    'sections instead of the whole page. Not for files on this machine: use read_file or read_document for those.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http(s) URL' },
      query: { type: 'string', description: 'What you need from the page; returns only the matching sections' },
      max_chars: { type: 'number', description: `Maximum characters to return (default ${DEFAULT_CHARS})` },
    },
    required: ['url'],
  },
  async execute(args, ctx) {
    let url: URL;
    try {
      url = new URL(String(args.url ?? '').trim());
    } catch {
      return fail(`Invalid URL: ${args.url}`, { code: TOOL_ERROR_CODE.EINVAL });
    }
    const maxChars = Number(args.max_chars) > 0 ? Math.min(Number(args.max_chars), MAX_CHARS) : DEFAULT_CHARS;
    const query = String(args.query ?? '').trim() || undefined;

    let page = pages.get(url.href);
    if (!page) {
      const t = withTimeoutSignal(ctx.signal, TIMEOUT_MS);
      try {
        const fetched = await fetchPage(url, t.signal, MAX_BYTES);
        if (!('bytes' in fetched)) {
          return fail(fetched.kind === 'refused' ? `Refused: ${fetched.message}` : fetched.message, {
            code: fetched.kind === 'refused' ? TOOL_ERROR_CODE.EDENIED : TOOL_ERROR_CODE.EUNKNOWN,
          });
        }
        const extracted = await extract(fetched);
        if (typeof extracted === 'string') return fail(extracted, { code: TOOL_ERROR_CODE.EINVAL });
        page = extracted;
        pages.set(url.href, page, CACHE_TTL_MS);
      } catch (err) {
        if (t.signal.aborted) {
          return fail(t.timedOut() ? `Fetch timed out: ${url.href}` : `Fetch cancelled: ${url.href}`, { code: TOOL_ERROR_CODE.ETIMEDOUT });
        }
        if (!isUnreachable(err)) return fromError(err);
        const root = causeChain(err).at(-1);
        const reason = root && root !== err ? String(root.message ?? '').trim() : '';
        const detail = reason && !/fetch failed|ECONN|ENOTFOUND|socket|timed? ?out/i.test(reason) ? ` (${reason.slice(0, 80)})` : '';
        return fail(
          `The site refused the connection at the network level${detail}, so retrying this URL will not help. Use a reachable source instead: ` +
            'the web_search snippets already returned, a REST/JSON endpoint, or for a factual topic Wikipedia (https://en.wikipedia.org/api/rest_v1/page/summary/<Title>).',
          { code: TOOL_ERROR_CODE.EUNKNOWN, data: { networkFailure: true } },
        );
      } finally {
        t.dispose();
      }
    }

    const header = [page.title && `# ${page.title}`, `Source: ${page.url}`].filter(Boolean).join('\n');
    if ('doc' in page) {
      const view = renderDocument(page.doc, path.basename(new URL(page.url).pathname) || url.hostname, { query, maxChars });
      if (!view.ok) return fail(view.error, { code: TOOL_ERROR_CODE.EINVAL });
      return ok({ kind: 'web', display: `${header}\n\n${view.text}`, truncated: view.truncated, data: { url: page.url, contentType: page.contentType, format: page.doc.format } });
    }
    const { body, truncated } = renderText(page.text, query, maxChars);
    return ok({
      kind: 'web',
      display: `${header}\n\n${body}`,
      truncated,
      data: { url: page.url, title: page.title, contentType: page.contentType, chars: page.text.length, fullContent: page.text },
    });
  },
});
