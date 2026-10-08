import { logger } from '../../core/logger';
import { withTimeoutSignal } from '../core/timeout-signal';
import { TtlCache } from '../content/cache';
import { termCoverage } from '../content/relevance';
import { declaredIntent, isSpecialized, keywordsOf, understand, type DeclaredSearch } from './intent';
import { PROVIDERS } from './providers/index';
import { ProviderError, type ProviderFailure, type QueryIntent, type SearchHit, type SearchProvider } from './types';

const PROVIDER_TIMEOUT_MS = 6_000;
// A provider weighted under half the best one is a fallback: it only counts when every primary came back empty.
const FALLBACK_RATIO = 0.5;
// Once there are answers, lesser primaries get this long before the search returns without them.
const GRACE_MS = 2_000;
const MIN_RELATIVE_COVERAGE = 0.5;
// Fallback sources answer only when the suited ones found nothing; a hit sharing under half the query words is then off topic, not a weaker answer.
const MIN_FALLBACK_COVERAGE = 0.5;
const RECENT_DAYS = 30;
const TRACKING_PARAM = /^(utm_\w+|ref|fbclid|gclid|mc_cid|mc_eid)$/i;

export interface SearchOutcome {
  results: SearchHit[];
  failures: ProviderFailure[];
  /** The sources suited to the question found nothing; these results are general ones that may not answer it. */
  fallbackOnly?: boolean;
}

interface SearchOptions {
  limit: number;
  signal?: AbortSignal;
  providers?: readonly SearchProvider[];
  timeoutMs?: number;
  graceMs?: number;
  cache?: TtlCache<SearchOutcome> | null;
  /** What the model said it is looking up; without it the query's words pick the sources. */
  declared?: DeclaredSearch;
}

const searchCache = new TtlCache<SearchOutcome>(64);

/** The same page reached through http/https, www, a trailing slash, a fragment or tracking parameters is one result. */
export function urlKey(raw: string): string {
  try {
    const u = new URL(raw);
    const params = [...u.searchParams].filter(([k]) => !TRACKING_PARAM.test(k)).sort(([a], [b]) => a.localeCompare(b));
    const query = params.length ? `?${new URLSearchParams(params)}` : '';
    return `${u.hostname.replace(/^www\./, '').toLowerCase()}${u.pathname.replace(/\/+$/, '')}${query}`;
  } catch {
    return raw.toLowerCase();
  }
}

function titleKey(title: string): string {
  const key = title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return key.length >= 20 ? key : ''; // short titles ("Home", "Python") are too generic to call duplicates
}

function ttlFor(intent: QueryIntent, failures: ProviderFailure[]): number {
  const base = isSpecialized(intent) ? 2 * 60_000 : intent.news ? 5 * 60_000 : 30 * 60_000;
  const partial = failures.some((f) => f.kind !== 'empty');
  return partial ? Math.min(base, 60_000) : base;
}

// A question about now: a hit from today earns up to 0.8, fading to nothing at a month old; undated hits earn nothing.
function recency(hit: SearchHit, now: number): number {
  const at = hit.publishedAt ? Date.parse(hit.publishedAt) : NaN;
  if (!Number.isFinite(at)) return 0;
  return 0.8 * Math.max(0, 1 - (now - at) / (RECENT_DAYS * 86_400_000));
}

interface Scored {
  hit: SearchHit;
  score: number;
}

/** Merge duplicates (keeping the fuller snippet and rewarding agreement) and order by provider weight, position and query coverage. */
export function rankHits(batches: Array<{ weight: number; hits: SearchHit[] }>, query: string, limit: number, preferRecent = false, now = Date.now(), minCoverage = 0): SearchHit[] {
  const byUrl = new Map<string, Scored>();
  const byTitle = new Map<string, Scored>();
  const all: Scored[] = [];
  for (const { weight, hits } of batches) {
    hits.forEach((hit, position) => {
      const score = weight / (1 + 0.2 * position) + 0.6 * termCoverage(`${hit.title} ${hit.snippet}`, query) + (preferRecent ? recency(hit, now) : 0);
      const uKey = urlKey(hit.url);
      const tKey = titleKey(hit.title);
      const seen = byUrl.get(uKey) ?? (tKey ? byTitle.get(tKey) : undefined);
      if (seen) {
        seen.score = Math.max(seen.score, score) + 0.3;
        if (hit.snippet.length > seen.hit.snippet.length) seen.hit = { ...seen.hit, snippet: hit.snippet };
        return;
      }
      const entry = { hit, score };
      all.push(entry);
      byUrl.set(uKey, entry);
      if (tKey) byTitle.set(tKey, entry);
    });
  }
  // Drop hits that share far fewer query words than the best one; relative, so a lone exact answer always stays.
  const coverage = new Map(all.map((s) => [s, termCoverage(`${s.hit.title} ${s.hit.snippet}`, query)]));
  // A query with no words to match ("q") cannot be covered, so only the relative floor applies to it.
  const coverable = termCoverage(query, query) > 0;
  const floor = Math.max(Math.max(...coverage.values(), 0) * MIN_RELATIVE_COVERAGE, coverable ? minCoverage : 0);
  return all.filter((s) => coverage.get(s)! >= floor).sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.hit);
}

/** Ask every relevant provider at once; one slow or failing provider never blocks the rest, and nothing is retried. */
export async function searchWeb(query: string, opts: SearchOptions): Promise<SearchOutcome> {
  const { limit, signal, providers = PROVIDERS, timeoutMs = PROVIDER_TIMEOUT_MS, graceMs = GRACE_MS } = opts;
  const cache = opts.cache === undefined ? searchCache : opts.cache;
  const cacheKey = `${limit}|${query.toLowerCase().replace(/\s+/g, ' ').trim()}${opts.declared ? `|${JSON.stringify(opts.declared)}` : ''}`;
  const cached = cache?.get(cacheKey);
  if (cached) return cached;

  // A kind the model declared picks the sources; only an undeclared query has them read from its words.
  const intent = opts.declared ? declaredIntent(query, opts.declared) : understand(query);
  const asked = providers.map((provider) => ({ provider, weight: provider.weight(intent) })).filter((a) => a.weight > 0);
  const best = Math.max(0, ...asked.map((a) => a.weight));
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const failures: ProviderFailure[] = [];
  const batches: Array<{ weight: number; primary: boolean; hits: SearchHit[] }> = [];
  const runs = asked.map(({ provider, weight }) => {
    const primary = weight >= best * FALLBACK_RATIO;
    const top = weight >= best;
    const run = (async () => {
      const t = withTimeoutSignal(stop.signal, timeoutMs);
      try {
        const hits = await provider.search(intent, limit, t.signal);
        if (hits.length === 0) failures.push({ provider: provider.id, kind: 'empty', message: `${provider.id}: no results` });
        else batches.push({ weight, primary, hits });
      } catch (err) {
        if (stop.signal.aborted && !t.timedOut() && !signal?.aborted) return; // cut off because other sources already answered
        const kind = t.timedOut() ? 'timeout' : err instanceof ProviderError ? err.kind : 'network';
        const message = t.timedOut() ? `${provider.id}: no answer within ${timeoutMs / 1000}s` : ((err as Error)?.message ?? String(err));
        failures.push({ provider: provider.id, kind, message });
        logger.debug(`web_search ${provider.id} failed (${kind}): ${message}`);
      } finally {
        t.dispose();
      }
    })();
    return { primary, top, run };
  });

  try {
    // The best-suited sources are always waited for (their own timeout bounds it); lesser primaries get a grace period once there are answers.
    await Promise.all(runs.filter((r) => r.top).map((r) => r.run));
    const rest = Promise.all(runs.filter((r) => r.primary && !r.top).map((r) => r.run));
    await (batches.length > 0 ? Promise.race([rest, sleep(graceMs)]) : rest);
    if (batches.some((b) => b.primary)) stop.abort();
    else await Promise.all(runs.map((r) => r.run));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }

  const fromPrimary = batches.some((b) => b.primary);
  const usable = fromPrimary ? batches.filter((b) => b.primary) : batches;
  // Scored against the plain keywords: dates and site: filters in the query say nothing about a hit's relevance.
  const results = rankHits(usable, keywordsOf(intent), limit, intent.news || intent.recent, Date.now(), fromPrimary ? 0 : MIN_FALLBACK_COVERAGE);
  const outcome = { results, failures, ...(fromPrimary || results.length === 0 ? {} : { fallbackOnly: true }) };
  if (outcome.results.length > 0 && !signal?.aborted) cache?.set(cacheKey, outcome, ttlFor(intent, failures));
  return outcome;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.());
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// The weekday is spelled out so the model never has to work it out (and get it wrong) from the date.
function when(iso?: string): string {
  return iso ? `${WEEKDAYS[new Date(iso).getUTCDay()]} ${iso.slice(0, 16).replace('T', ' ')} UTC` : '';
}

/** Numbered, compact results the answer can cite as [n]; each source's freshness caveat is stated once, not per result. */
export function formatResults(results: SearchHit[]): string {
  const lines = results.map((r, i) => {
    const stamp = [r.freshness, when(r.publishedAt)].filter(Boolean).join(' ');
    return `${i + 1}. ${r.title} — ${r.source}, ${stamp}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`;
  });
  const notes = [...new Map(results.filter((r) => r.delayNote).map((r) => [r.source, `${r.source}: ${r.delayNote}`])).values()];
  return notes.length ? `${lines.join('\n')}\n\nFreshness: ${notes.join('; ')}.` : lines.join('\n');
}
