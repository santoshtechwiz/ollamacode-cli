import { isSpecialized, keywordsOf } from '../intent';
import type { SearchHit, SearchProvider } from '../types';
import { getJson, makeHit, toIso } from './shared';

export const wikipedia: SearchProvider = {
  id: 'wikipedia',
  weight: (intent) => (isSpecialized(intent) ? 0.2 : intent.news || intent.recent ? 0.4 : 1),
  async search(intent, limit, signal) {
    const url =
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(keywordsOf(intent))}` +
      `&format=json&srlimit=${Math.min(limit, 10)}&srprop=snippet%7Ctimestamp&origin=*`;
    const data = await getJson(url, 'wikipedia', signal);
    const rows: any[] = Array.isArray(data?.query?.search) ? data.query.search : [];
    return rows
      .map((r) => makeHit({
        source: 'Wikipedia',
        title: r?.title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r?.title ?? '').replace(/ /g, '_'))}`,
        snippet: r?.snippet,
        freshness: 'cached',
        publishedAt: toIso(r?.timestamp),
        delayNote: 'encyclopedia article; the date is its last edit',
      }))
      .filter((h): h is SearchHit => h !== null);
  },
};

export const duckduckgo: SearchProvider = {
  id: 'duckduckgo-instant',
  weight: (intent) => (isSpecialized(intent) ? 0.2 : intent.news || intent.recent ? 0.4 : 0.9),
  async search(intent, limit, signal) {
    const data = await getJson(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(keywordsOf(intent))}&format=json&no_html=1&skip_disambig=1`,
      'duckduckgo-instant', signal,
    );
    if (!data || typeof data !== 'object') return [];
    const hits: SearchHit[] = [];
    const add = (title: unknown, url: unknown, snippet: unknown) => {
      const hit = makeHit({ source: 'DuckDuckGo', title, url: String(url ?? ''), snippet, freshness: 'cached', delayNote: 'instant-answer summary, undated' });
      if (hit && hits.length < limit) hits.push(hit);
    };
    if (data.AbstractText && data.AbstractURL) add(data.Heading || intent.query, data.AbstractURL, data.AbstractText);
    const topics: any[] = (Array.isArray(data.RelatedTopics) ? data.RelatedTopics : []).flatMap((t: any) => (Array.isArray(t?.Topics) ? t.Topics : [t]));
    for (const t of topics) {
      const text = String(t?.Text ?? '');
      const dash = text.indexOf(' - ');
      if (text && t?.FirstURL) add(dash > 0 ? text.slice(0, dash) : text.slice(0, 80), t.FirstURL, text);
    }
    return hits;
  },
};
