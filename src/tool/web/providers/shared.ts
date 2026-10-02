import { htmlToText } from '../../content/html';
import { ProviderError, type SearchHit } from '../types';
import { UA } from '../fetch';

function looksLikeChallenge(text: string): boolean {
  return /anomaly-modal|challenge-form|assets\/anomaly\/|<title>\s*captcha\s*<\/title>|proof-of-work|bot challenge/i.test(text);
}

/** One GET for a provider; the caller's signal carries the deadline, and every failure becomes a classified ProviderError. */
export async function getText(url: string, provider: string, signal: AbortSignal): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/json,text/csv,text/plain;q=0.9,*/*;q=0.5' },
    });
  } catch (err) {
    if (signal.aborted) throw new ProviderError(provider, 'timeout', `${provider}: timed out`);
    throw new ProviderError(provider, 'network', `${provider}: ${(err as Error)?.message ?? err}`);
  }
  if (res.status === 429) throw new ProviderError(provider, 'rate-limited', `${provider}: rate-limited`);
  if (res.status === 403 || res.status === 503) throw new ProviderError(provider, 'blocked', `${provider}: HTTP ${res.status}`);
  if (!res.ok) throw new ProviderError(provider, 'network', `${provider}: HTTP ${res.status}`);
  const text = await res.text().catch((err) => {
    throw new ProviderError(provider, signal.aborted ? 'timeout' : 'network', `${provider}: ${(err as Error)?.message ?? err}`);
  });
  if (looksLikeChallenge(text)) throw new ProviderError(provider, 'blocked', `${provider}: bot-verification challenge`);
  return text;
}

export async function getJson(url: string, provider: string, signal: AbortSignal): Promise<any> {
  const text = await getText(url, provider, signal);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Unix seconds/ms, or anything Date.parse reads, as ISO. */
export function toIso(raw: unknown): string | undefined {
  const s = String(raw ?? '').trim();
  if (!s) return undefined;
  const ms = /^\d{10}$/.test(s) ? Number(s) * 1000 : /^\d{13}$/.test(s) ? Number(s) : Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const SNIPPET_CHARS = 220;

/** A normalized hit, or null when the title or URL is unusable. */
export function makeHit(fields: Omit<SearchHit, 'title' | 'snippet'> & { title: unknown; snippet: unknown }): SearchHit | null {
  const title = htmlToText(String(fields.title ?? '')).replace(/\s+/g, ' ').trim();
  const url = String(fields.url ?? '').trim();
  if (!title || !/^https?:\/\//i.test(url)) return null;
  const text = htmlToText(String(fields.snippet ?? '')).replace(/\s+/g, ' ').trim();
  const snippet = text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS - 1)}…` : text;
  return { ...fields, title, url, snippet };
}
