import { PROVIDER_ERROR_CODE } from '../../protocol';
import { createEngine } from '../../core/wasm/loader';
import { ProviderError, isCancel } from '../../core/errors';

export async function* readLines(res: Response, { signal }: { signal?: AbortSignal; } = {}): AsyncGenerator<string, void, unknown> {
  if (!res.body || typeof ( (res.body as any).getReader) !== 'function') {
    throw new ProviderError('response body is not streamable', { code: PROVIDER_ERROR_CODE.ENOSTREAM });
  }

  const engine = await createEngine();
  const reader = (
 (res.body as any).getReader() as ReadableStreamDefaultReader<Uint8Array>
  );

  try {
    for (;;) {
      if (signal?.aborted) throw new ProviderError('stream aborted', { code: PROVIDER_ERROR_CODE.ECANCELLED });
      const { done, value } = await reader.read();
      if (done) break;
      const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
      for (const line of engine.feedBytes(bytes)) yield line;
    }
    for (const line of engine.flush()) yield line;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {
    }
  }
}

interface SseEvent {
  data: string;
  event?: string;
  id?: string;
}

export async function* readSse(res: Response, { signal }: { signal?: AbortSignal; } = {}): AsyncGenerator<SseEvent, void, unknown> {
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;

  const flushEvent = () => {
    if (data.length === 0) return null;
    const out = { data: data.join('\n'), event, id };
    data = [];
    event = undefined;
    id = undefined;
    return out;
  };

  for await (const line of readLines(res, { signal })) {
    if (line === '') {
      const evt = flushEvent();
      if (evt) yield evt;
      continue;
    }
    if (line.startsWith(':')) continue;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    else if (field === 'id') id = value;
  }

  const tail = flushEvent();
  if (tail) yield tail;
}

export async function guardTruncation(label: string, consume: () => Promise<void>, completedCleanly: () => boolean): Promise<boolean> {
  try {
    await consume();
  } catch (err) {
    if (isCancel(err)) return true;
    throw err;
  }
  if (!completedCleanly()) {
    throw new ProviderError(
      `${label} stream ended before completion (connection dropped mid-response)`,
      { code: PROVIDER_ERROR_CODE.ETRUNCATED, retryable: true }
    );
  }
  return false;
}

