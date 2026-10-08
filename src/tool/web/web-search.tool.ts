import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { withTimeoutSignal } from '../core/timeout-signal';
import { logger } from '../../core/logger';
import { searchWeb, formatResults } from './search';
import { SEARCH_KINDS } from './intent';

// Providers carry their own shorter deadline; this only bounds the whole call.
const TIMEOUT_MS = 12_000;
const DEFAULT_LIMIT = 6;

export default defineTool({
  name: 'web_search',
  aliases: ['search_web', 'google'],
  argAliases: {
    max_results: 'limit',
    num_results: 'limit',
    q: 'query',
    search: 'query',
    text: 'query',
  },
  profiles: ['core'],
  category: 'web',
  activity: 'Searching the web',
  label: 'Web Search',
  brief:
    'Look up current information on the web: news, weather, prices, a library\'s latest version, anything after your training data. Returns source, title, URL, date and freshness.',
  description:
    'Search public sources (general, news, markets, weather); returns source, title, URL, date, snippet and freshness. ' +
    'Use it for anything newer than your training data (news, prices, versions); skip it when the workspace already ' +
    'answers. Short keyword queries, no guessed years. Answer only from the snippets, cite them as [n] with the URL, ' +
    'give the date/freshness, and say when results are delayed or missing. Not for workspace files (use grep_content or ' +
    'find_files); read one result with web_fetch.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: `Maximum results (default ${DEFAULT_LIMIT})` },
      kind: {
        type: 'string',
        enum: [...SEARCH_KINDS],
        description:
          'What you are looking up; it picks the sources. stock, crypto and currency ask market data (give symbols), ' +
          'weather asks a forecast service (give place), news asks news sources newest first. Leave it out to have the query words decide.',
      },
      symbols: {
        type: 'array',
        items: { type: 'string' },
        description: 'For stock: tickers ("AAPL"). For crypto: coin names ("bitcoin"). For currency: the two codes, from then to ("USD", "EUR").',
      },
      place: { type: 'string', description: 'For weather: the city or place, e.g. "Pune" or "Austin, Texas".' },
    },
    required: ['query'],
  },
  // The same set of pages, however the query was worded.
  async execute(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) return fail('Missing required argument: query', { code: TOOL_ERROR_CODE.EINVAL });
    const limit = Number(args.limit) > 0 ? Math.min(Math.floor(Number(args.limit)), 15) : DEFAULT_LIMIT;

    const t = withTimeoutSignal(ctx.signal, TIMEOUT_MS);
    try {
      logger.debug(`web_search ${JSON.stringify(query)}`);
      const kind = SEARCH_KINDS.find((k) => k === args.kind);
      const declared = kind
        ? {
            kind,
            ...(Array.isArray(args.symbols) ? { symbols: args.symbols.map(String) } : {}),
            ...(typeof args.place === 'string' && args.place.trim() ? { place: args.place.trim() } : {}),
          }
        : undefined;
      const { results, failures, fallbackOnly } = await searchWeb(query, { limit, signal: t.signal, ...(declared ? { declared } : {}) });
      if (ctx.signal?.aborted) return fail('Search cancelled', { code: TOOL_ERROR_CODE.ETIMEDOUT });

      if (results.length === 0) {
        const blocked = failures.some((f) => f.kind === 'blocked');
        const limited = failures.some((f) => f.kind === 'rate-limited');
        const slow = failures.some((f) => f.kind === 'timeout');
        return ok({
          kind: 'web',
          display:
            `No usable results for ${JSON.stringify(query)}` +
            (blocked ? ' — a source answered with a bot-verification challenge' : '') +
            (limited ? ' — a source rate-limited the request' : '') +
            (slow ? ' — a source was too slow to answer' : '') +
            '. This found nothing, not "nothing new to report": do not answer as if this search confirmed it. ' +
            'Retry at most once with a shorter query — just the topic, without dates, quotes, site: filters or OR lists — otherwise tell the user plainly that the search returned nothing before answering from anything else you know. ' +
            'Never invent a price, date, version, or headline that no source returned.',
          data: { query, results: [], failures, blocked, rateLimited: limited },
        });
      }

      // Placed after the results so the first line the user sees is still the top result.
      const caveat = fallbackOnly
        ? `\n\nThe sources meant for this kind of question (news, weather or prices) found nothing for ${JSON.stringify(query)}; these are general reference results and may not answer it. Say so rather than treating them as current.`
        : '';
      return ok({ kind: 'web', display: formatResults(results) + caveat, data: { query, results, failures } });
    } catch (err) {
      return fromError(err);
    } finally {
      t.dispose();
    }
  },
});
