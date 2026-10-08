/** Capped per-stream capture for background subprocesses. */

const MAX_SUB_BUFFER = 1 * 1024 * 1024;

export interface CappedOutput {
  chunks: string[];
  bytes: number;
  discardedBytes: number;
}

export function createOutput(): CappedOutput {
  return { chunks: [], bytes: 0, discardedBytes: 0 };
}

/** Append a chunk; beyond the cap, count it as discarded instead of storing it. */
export function pushOutput(out: CappedOutput, chunk: Buffer, cap: number = MAX_SUB_BUFFER): void {
  if (out.bytes >= cap) {
    out.discardedBytes += chunk.length;
    return;
  }
  out.chunks.push(chunk.toString('utf8'));
  out.bytes += chunk.length;
}

export function readOutput(out: CappedOutput): string {
  return out.chunks.join('');
}

export function clearOutput(out: CappedOutput): void {
  out.chunks.length = 0;
  out.bytes = 0;
}
