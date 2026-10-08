type Freshness = 'live' | 'delayed' | 'cached';

export interface SearchHit {
  source: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  freshness: Freshness;
  /** Why the data is not live, e.g. "delayed quote (≈15 min / EOD)"; shown once per source. */
  delayNote?: string;
}

/** What a query is about, worked out once so every provider reads the same answer. */
export interface QueryIntent {
  query: string;
  tickers: string[];
  coins: string[];
  fx: { from: string; to: string } | null;
  weather: boolean;
  /** What the named place could be called, longest first; absent when the query names none. */
  places?: string[];
  news: boolean;
  /** Asks about now: recency words ("latest", "today") or a recent date, even without the word "news". */
  recent: boolean;
  /** The query minus recency words and explicit dates, which only narrow a search that is already sorted by date. */
  topic: string;
}

/** A web-search backend; add one by writing it and listing it in providers/index.ts. */
export interface SearchProvider {
  id: string;
  /** How well this provider answers the intent, 0..1; 0 means it is not asked at all. */
  weight(intent: QueryIntent): number;
  search(intent: QueryIntent, limit: number, signal: AbortSignal): Promise<SearchHit[]>;
}

type ProviderFailureKind = 'blocked' | 'rate-limited' | 'timeout' | 'network' | 'empty';

export interface ProviderFailure {
  provider: string;
  kind: ProviderFailureKind;
  message: string;
}

export class ProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly kind: ProviderFailureKind,
    message: string,
  ) {
    super(message);
  }
}
