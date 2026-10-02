import { PROVIDER_ERROR_CODE } from '../../protocol';
import { ProviderError } from '../../core/errors';
import { isCancel } from '../../core/errors';
import { logger } from '../../core/logger';

const _fetch = globalThis.fetch;

const fetchGeneration = 0;

export function getFetchGeneration(): number {
  return fetchGeneration;
}

export function getFetch(): typeof globalThis.fetch {
  return _fetch;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function backoffDelay(attempt: number, base: number = 400): number {
  const exponential = base * 2 ** attempt;
  const jitter = Math.random() * base;
  return Math.min(exponential + jitter, 8000);
}

export function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;

  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  if (ms > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`timed out after ${ms}ms`));
    }, ms);
  }

  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    dispose() {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    },
  };
}

/** The error codes a refused, unresolved or dropped connection arrives under. */
const OFFLINE_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

export function causeChain(err: unknown): any[] {
  const chain: any[] = [];
  const seen = new Set<unknown>();
  for (let e: any = err; e && !seen.has(e); e = e.cause) {
    seen.add(e);
    chain.push(e);
  }
  return chain;
}

/** Was the backend unreachable, rather than merely unhappy with the request? */
export function isUnreachable(err: unknown): boolean {
  const chain = causeChain(err);
  if (chain.some((e) => e instanceof TypeError && /fetch failed/i.test(String(e.message)))) return true;
  return chain.some((e) => typeof e.code === 'string' && OFFLINE_CODES.has(e.code));
}

/** Say what could not be reached and what would make it reachable. */
export function unreachableError(url: string, hint: string, cause: unknown): ProviderError {
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    // a base that is not a URL is still worth naming verbatim
  }
  // The hint covers the usual reason — nothing listening.
  const root = causeChain(cause).at(-1);
  const reason = root && root !== cause ? String(root.message ?? '') : '';
  const detail =
    reason && !/fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|timed? ?out/i.test(reason) ? ` (${reason})` : '';

  return new ProviderError(`cannot reach ${origin} — ${hint}${detail}`, {
    code: PROVIDER_ERROR_CODE.EPROVIDER_UNAVAILABLE,
    retryable: false,
    cause,
  });
}

export async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number; retries?: number; label?: string; } = {}): Promise<Response> {
  const { timeoutMs = 15000, retries = 2, label = 'request', ...rest } = init;
  let lastErr: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const t = withTimeout(rest.signal ?? undefined, timeoutMs);
    try {
      const res = await _fetch(url, { ...rest, signal: t.signal });
      if (RETRYABLE_STATUS.has(res.status) && attempt < retries) {
        lastErr = new ProviderError(`${label} failed: HTTP ${res.status}`, {
          status: res.status,
          retryable: true,
        });
        await sleep(retryAfterMs(res) ?? backoffDelay(attempt));
        continue;
      }
      return res;
    } catch (err) {
      if (isCancel(err) && !t.timedOut) throw err;
      lastErr = t.timedOut
        ? new ProviderError(`${label} timed out after ${timeoutMs}ms`, {
            code: PROVIDER_ERROR_CODE.ETIMEDOUT,
            retryable: true,
            cause: err,
          })
        : new ProviderError(`${label} failed: ${ (err as Error).message}`, {
            retryable: true,
            cause: err,
          });
      if (attempt < retries) await sleep(backoffDelay(attempt));
    } finally {
      t.dispose();
    }
  }
  throw lastErr;
}

function retryAfterMs(res: Response): number | null {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 10000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 10000)) : null;
}

/** A throughput figure, or a dash when there is nothing to divide by. */
export function formatRate(tokensPerSec: number | undefined): string {
  return tokensPerSec === undefined || !Number.isFinite(tokensPerSec)
    ? 'not timed'
    : `${Math.round(tokensPerSec)} tok/s`;
}

/** An Ollama nanosecond duration as milliseconds, or `undefined` when the wire did not send one. */
export function optionalMs(ns: unknown): number | undefined {
  const ms = Number(ns) / 1e6;
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** The timing fragment of a provider debug line: real numbers, or `timing=unavailable` when the wire sent no durations — never `in 0ms`. */
export function formatWireTiming({ promptTokens, genTokens, promptMs, genMs, loadMs }: {
  promptTokens?: number; genTokens?: number; promptMs?: number; genMs?: number; loadMs?: number;
}): string {
  const counts = `${promptTokens ?? '?'} prompt tok + ${genTokens ?? '?'} gen tok`;
  if (promptMs === undefined || genMs === undefined) return `${counts} (timing=unavailable)`;
  const load = loadMs === undefined ? '' : ` · load ${Math.round(loadMs)}ms`;
  return `${promptTokens ?? '?'} prompt tok in ${Math.round(promptMs)}ms + ` +
    `${genTokens ?? '?'} gen tok in ${Math.round(genMs)}ms${load}`;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function errorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 500);
  } catch {
    return '';
  }
}


/** The exact JSON a provider is about to POST, to the `--debug` log file only. */
export function traceWireBody(url: string, body: Record<string, unknown>) {
  if (!logger.enabled('trace')) return;
  const { messages, tools, ...rest } = body ?? {};
  const count = (list: unknown) => (Array.isArray(list) ? list.length : 0);
  logger.traceBlock(
    `wire POST ${url}`,
    JSON.stringify({
      ...rest,
      messages: `<${count(messages)} message(s), see request.messages>`,
      ...(tools ? { tools: `<${count(tools)} tool(s), see request.tools>` } : {}),
    }, null, 2)
  );
}
