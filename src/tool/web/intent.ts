import type { QueryIntent } from './types';

// Keyword and symbol routing only: these decide which providers are asked, never what the answer is.

const COMPANY_TO_TICKER: Record<string, string> = {
  apple: 'AAPL', tesla: 'TSLA', nvidia: 'NVDA', microsoft: 'MSFT', google: 'GOOGL', alphabet: 'GOOGL',
  amazon: 'AMZN', meta: 'META', facebook: 'META', netflix: 'NFLX', amd: 'AMD', intel: 'INTC',
};

const COIN_MAP: Record<string, string> = {
  bitcoin: 'bitcoin', btc: 'bitcoin', ethereum: 'ethereum', eth: 'ethereum', solana: 'solana', sol: 'solana',
  dogecoin: 'dogecoin', doge: 'dogecoin', cardano: 'cardano', ada: 'cardano',
};

const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'INR', 'CNY']);

/** Tickers from `$AAPL`, a known company named next to a market word, or `XXX stock/price` shapes. */
function extractTickers(query: string): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const t = s.toUpperCase();
    if (/^[A-Z]{1,5}$/.test(t) && !out.includes(t)) out.push(t);
  };
  for (const m of query.matchAll(/\$([A-Za-z]{1,5})\b/g)) push(m[1]);
  const lower = query.toLowerCase();
  if (/\b(stock|stocks|shares?|price|quote|market cap|trading)\b/.test(lower)) {
    for (const [name, ticker] of Object.entries(COMPANY_TO_TICKER)) {
      if (new RegExp(`\\b${name}\\b`).test(lower)) push(ticker);
    }
  }
  for (const m of query.matchAll(/\b([A-Z]{2,5})\s+(?:stock|shares?|price|quote)\b/g)) push(m[1]);
  return out.slice(0, 3);
}

function extractCoins(query: string): string[] {
  const out: string[] = [];
  for (const [word, id] of Object.entries(COIN_MAP)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(query) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 3);
}

function extractFxPair(query: string): { from: string; to: string } | null {
  const upper = query.toUpperCase();
  const pair = (a: string, b: string) => (CURRENCIES.has(a) && CURRENCIES.has(b) && a !== b ? { from: a, to: b } : null);
  const m = /\b([A-Z]{3})\s*(?:[/:]|\s+TO\s+|\s+IN\s+)\s*([A-Z]{3})\b/.exec(upper) ?? /\b([A-Z]{3})([A-Z]{3})\b/.exec(upper);
  return m ? pair(m[1], m[2]) : null;
}

const MAX_PLACE_WORDS = 4;
const WEATHER_WORDS = /\b(?:weather|forecast|raining|temperature|precipitation|humidity|umbrella|uv index|will it (?:rain|snow)|chance of (?:rain|snow))\b/i;

/** Names the place could be, longest first: "in Kuala Lumpur live report" → "Kuala Lumpur live report", …, "Kuala". The geocoder picks the longest it knows. */
function extractPlaces(topic: string): string[] | undefined {
  const words = (s: string) => s.split(/[^A-Za-z.'-]+/).map((w) => w.replace(/^[.'-]+|[.'-]+$/g, '')).filter(Boolean);
  const after = /\b(?:in|for|at|near)\s+(.+)$/i.exec(topic)?.[1] ?? new RegExp(`${WEATHER_WORDS.source}\\s+(.+)$`, 'i').exec(topic)?.[1];
  const before = words(topic.split(WEATHER_WORDS)[0] ?? '');
  // Words after the cue are cut from the end ("Paris tomorrow morning"); words before "weather" count only as a whole short phrase ("Kuala Lumpur weather"), since "is it raining" names no place.
  const spans = after !== undefined
    ? words(after).slice(0, MAX_PLACE_WORDS).map((_, i, w) => w.slice(0, w.length - i).join(' '))
    : before.length > 0 && before.length <= MAX_PLACE_WORDS ? [before.join(' ')] : [];
  const places = spans.filter((p) => /[A-Za-z]{2}/.test(p));
  return places.length ? places : undefined;
}

// Only words that unambiguously mean news; "latest" and "today" also show up in version questions.
const NEWS_WORDS = /\b(news|headlines?|breaking|happening)\b/gi;
const RECENCY_WORDS = /\b(latest|recent(ly)?|newest|current(ly)?|today|tonight|this (week|month))\b/gi;
const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';
// "September 29, 2026", "29 Sept 2026", "2026-09-29", "Sept 29" and bare recent years: all say "recent", which sorting by date already delivers.
const DATES = new RegExp(`\\b(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?(?:\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?(?:\\s+\\d{4})?|\\d{4}-\\d{2}-\\d{2}|${MONTH}\\s+\\d{4})\\b`, 'gi');

function mentionsRecentYear(query: string, now = new Date()): boolean {
  return [...query.matchAll(/\b(\d{4})\b/g)].some((m) => Number(m[1]) >= now.getUTCFullYear() - 1 && Number(m[1]) <= now.getUTCFullYear() + 1);
}

function tidy(text: string): string {
  return text.replace(/["“”]\s*["“”]/g, ' ').replace(/[?!]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The query minus recency words and explicit dates; news providers already return the newest first. */
function topicOf(query: string): string {
  const years = new RegExp(`\\b(${new Date().getUTCFullYear() - 1}|${new Date().getUTCFullYear()}|${new Date().getUTCFullYear() + 1})\\b`, 'g');
  return tidy(query.replace(DATES, ' ').replace(RECENCY_WORDS, ' ').replace(years, ' ')) || query;
}

/** Plain keywords for engines that require every word to match: no news words, quotes, site: filters or OR lists. */
export function keywordsOf(intent: QueryIntent): string {
  const plain = intent.topic.replace(NEWS_WORDS, ' ').replace(/\bsite:\S+/gi, ' ').replace(/\b(OR|AND)\b/g, ' ').replace(/["“”()]/g, ' ');
  return tidy(plain) || intent.topic;
}

export function understand(query: string): QueryIntent {
  const weather = WEATHER_WORDS.test(query);
  const places = weather ? extractPlaces(topicOf(query)) : undefined;
  return {
    query,
    tickers: extractTickers(query),
    coins: extractCoins(query),
    fx: extractFxPair(query),
    weather,
    ...(places ? { places } : {}),
    news: new RegExp(NEWS_WORDS.source, 'i').test(query),
    recent: new RegExp(RECENCY_WORDS.source, 'i').test(query) || new RegExp(DATES.source, 'i').test(query) || mentionsRecentYear(query),
    topic: topicOf(query),
  };
}

export const SEARCH_KINDS = ['general', 'news', 'weather', 'stock', 'crypto', 'currency'] as const;
type SearchKind = (typeof SEARCH_KINDS)[number];

/** What the model said it is looking up. */
export interface DeclaredSearch {
  kind: SearchKind;
  /** Tickers for stock, coin names for crypto, the two currency codes for currency. */
  symbols?: string[];
  /** The place a weather lookup is for. */
  place?: string;
}

/** The intent the model declared: it chose the sources, so none are guessed from the query's words. */
export function declaredIntent(query: string, declared: DeclaredSearch): QueryIntent {
  const symbols = (declared.symbols ?? []).map((s) => String(s).trim()).filter(Boolean);
  const upper = symbols.map((s) => s.toUpperCase());
  const weather = declared.kind === 'weather';
  const place = String(declared.place ?? '').trim();
  const places = weather ? (place ? [place] : extractPlaces(topicOf(query))) : undefined;
  return {
    query,
    tickers: declared.kind === 'stock' ? upper.slice(0, 3) : [],
    coins: declared.kind === 'crypto' ? symbols.map((s) => s.toLowerCase()).slice(0, 3) : [],
    fx: declared.kind === 'currency' && upper.length >= 2 && upper[0] !== upper[1] ? { from: upper[0], to: upper[1] } : null,
    weather,
    ...(places ? { places } : {}),
    news: declared.kind === 'news',
    recent: new RegExp(RECENCY_WORDS.source, 'i').test(query) || new RegExp(DATES.source, 'i').test(query) || mentionsRecentYear(query),
    topic: topicOf(query),
  };
}

/** A market, weather or FX question, where encyclopedic sources only add noise. */
export function isSpecialized(intent: QueryIntent): boolean {
  return intent.tickers.length > 0 || intent.coins.length > 0 || intent.fx !== null || intent.weather;
}
