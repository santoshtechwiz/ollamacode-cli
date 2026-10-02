import dns from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { logger } from '../../core/logger';

const MAX_REDIRECTS = 5;
export const UA ='Mozilla/5.0 (compatible; ollamacode/0.1; +https://github.com/ollamacode/cli)';

/** ipaddr.js range names that mean "not a public internet address", for IPv4 and IPv6 alike. */
const UNSAFE_RANGES = new Set([
  'unspecified', 'broadcast', 'multicast', 'linkLocal', 'loopback', 'carrierGradeNat', 'private', 'reserved', 'uniqueLocal',
]);

export type FetchFailure = { kind: 'refused' | 'redirects' | 'http'; message: string };

export interface FetchedPage {
  url: string;
  contentType: string;
  bytes: Buffer;
  /** The body went past the byte cap and was cut there. */
  clipped: boolean;
}

/** Classifies one already-resolved address (never a hostname) against ipaddr.js's range table. */
function refuseAddress(addr: string): string | null {
  let parsed;
  try {
    parsed = ipaddr.process(addr); // unwraps an IPv4-mapped IPv6 address first
  } catch {
    return `refusing to fetch an unparseable address "${addr}"`;
  }
  const range = parsed.range();
  return UNSAFE_RANGES.has(range) ? `refusing to fetch a ${range} address (${addr})` : null;
}

/** Protocol, internal host names and literal addresses, then every DNS answer, so rebinding and redirect-target SSRF are caught per hop. */
async function refuseTarget(url: URL): Promise<string | null> {
  if (!/^https?:$/.test(url.protocol)) return `unsupported protocol "${url.protocol}" (only http and https)`;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return 'refusing to fetch a loopback/internal host';
  }
  if (ipaddr.isValid(host)) return refuseAddress(host);
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return null; // let fetch's own attempt produce the "not found" failure
  }
  for (const rec of records) {
    const refusal = refuseAddress(rec.address);
    if (refusal) return `${refusal} (resolved from ${host})`;
  }
  return null;
}

// Stream the body up to the cap so a huge page costs at most `maxBytes` of download and memory.
async function readCapped(res: Response, maxBytes: number): Promise<{ bytes: Buffer; clipped: boolean }> {
  if (!res.body) return { bytes: Buffer.alloc(0), clipped: false };
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.concat(chunks).subarray(0, maxBytes), clipped: true };
    }
  }
  return { bytes: Buffer.concat(chunks), clipped: false };
}

/** One public page, following redirects by hand so every hop is checked; a failed connection is reported, not retried. */
export async function fetchPage(start: URL, signal: AbortSignal, maxBytes: number): Promise<FetchedPage | FetchFailure> {
  let current = start;
  for (let redirects = 0; ; redirects++) {
    const refusal = await refuseTarget(current);
    if (refusal) return { kind: 'refused', message: current === start ? refusal : `${refusal} (redirected from ${start.href})` };
    logger.debug(`web_fetch ${current.href}`);
    const res = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,application/pdf;q=0.8,*/*;q=0.5' },
    });
    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (location) {
      await res.body?.cancel().catch(() => {});
      if (redirects >= MAX_REDIRECTS) return { kind: 'redirects', message: `Too many redirects fetching ${start.href}` };
      try {
        current = new URL(location, current);
      } catch {
        return { kind: 'redirects', message: `Redirect to an invalid URL from ${current.href}` };
      }
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { kind: 'http', message: `HTTP ${res.status} ${res.statusText} for ${current.href}` };
    }
    const { bytes, clipped } = await readCapped(res, maxBytes);
    return { url: current.href, contentType: res.headers.get('content-type') ?? '', bytes, clipped };
  }
}
