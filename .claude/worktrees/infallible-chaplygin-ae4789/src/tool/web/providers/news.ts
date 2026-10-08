import { isSpecialized, keywordsOf } from '../intent';
import type { SearchHit, SearchProvider } from '../types';
import { getJson, getText, makeHit, toIso } from './shared';

export const hackerNews: SearchProvider = {
  id: 'hn-algolia',
  weight: (intent) => (intent.news ? 1 : isSpecialized(intent) ? 0 : intent.recent ? 0.8 : 0.5),
  async search(intent, limit, signal) {
    const data = await getJson(
      // Algolia requires every word, so it gets plain keywords; a question about now is limited to the last 90 days.
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(keywordsOf(intent))}&tags=story&hitsPerPage=${Math.min(limit, 20)}` +
        (intent.news || intent.recent ? `&numericFilters=created_at_i>${Math.floor(Date.now() / 1000) - 90 * 86_400}` : ''),
      'hn-algolia', signal,
    );
    const rows: any[] = Array.isArray(data?.hits) ? data.hits : [];
    return rows
      .map((h) => makeHit({
        source: 'Hacker News',
        title: h?.title,
        url: h?.url ? String(h.url) : `https://news.ycombinator.com/item?id=${h?.objectID ?? ''}`,
        snippet: typeof h?.points === 'number' ? `${h.points} points, ${h?.num_comments ?? 0} comments on Hacker News` : 'Hacker News discussion',
        freshness: 'live',
        publishedAt: toIso(h?.created_at),
      }))
      .filter((h): h is SearchHit => h !== null);
  },
};

function tag(item: string, name: string): string {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(item);
  return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, '') : '';
}

// Bing wraps each article in a click-tracking link; the real article URL rides in its `url` parameter.
function articleUrl(link: string): string {
  const href = link.replace(/&amp;/g, '&');
  try {
    return new URL(href).searchParams.get('url') ?? href;
  } catch {
    return href;
  }
}

async function bingRss(q: string, signal: AbortSignal): Promise<SearchHit[]> {
  const xml = await getText(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss`, 'bing-news', signal);
  return (xml.match(/<item>[\s\S]*?<\/item>/g) ?? [])
    .map((item) => makeHit({
      source: tag(item, 'News:Source') ? `Bing News (${tag(item, 'News:Source')})` : 'Bing News',
      title: tag(item, 'title'),
      url: articleUrl(tag(item, 'link')),
      snippet: tag(item, 'description'),
      freshness: 'live',
      publishedAt: toIso(tag(item, 'pubDate')),
    }))
    .filter((h): h is SearchHit => h !== null);
}

export const bingNews: SearchProvider = {
  id: 'bing-news',
  weight: (intent) => (isSpecialized(intent) ? 0 : intent.news || intent.recent ? 1 : 0.45),
  async search(intent, limit, signal) {
    // Bing drops everything for some phrasings ("latest …") and not others, so the query as written and its dateless topic are asked together.
    const variants = [...new Set([intent.query, intent.topic])];
    const settled = await Promise.allSettled(variants.map((q) => bingRss(q, signal)));
    const seen = new Set<string>();
    const hits = settled
      .flatMap((s) => (s.status === 'fulfilled' ? s.value : []))
      .filter((h) => !seen.has(h.url) && seen.add(h.url));
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (hits.length === 0 && failed) throw failed.reason;
    // Bing orders by relevance; a question about now wants the newest of those on-topic items first.
    if (intent.news || intent.recent) hits.sort((a, b) => (b.publishedAt ?? '').localeCompare(a.publishedAt ?? ''));
    return hits.slice(0, limit);
  },
};
