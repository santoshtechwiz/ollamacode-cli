/**
 * tc-llm-cli WebAssembly core (AssemblyScript).
 *
 * Incremental line splitter for streamed NDJSON (Ollama) and SSE
 * (HuggingFace). Every streamed token flows through `feed()`; partial trailing
 * lines are carried across calls until their terminator arrives.
 *
 * MEMORY LAYOUT
 * -------------
 * The previous version hardcoded IN_PTR/LEN_PTR/OUT_PTR at 4096/8192/16384 and
 * *also* allocated the carry buffer as a StaticArray. The runtime placed that
 * array at address 1360 with a length of 32768, so it physically covered all
 * three "reserved" regions: writing a line length at 8192 corrupted the very
 * input bytes still being scanned. The layout was only ever safe for chunks
 * smaller than ~2.7KB.
 *
 * Buffers are now real allocations and the module exports their addresses, so
 * the loader never guesses and the regions cannot overlap by construction.
 * Capacities are exported too, so bounds live in exactly one place.
 */

// A single logical line may legitimately be large: one SSE `data:` frame can
// carry a whole tool-call arguments blob.
const LEFT_CAP: i32 = 262144; // 256 KiB carry
const IN_CAP: i32 = 65536; //  64 KiB per feed
const OUT_CAP: i32 = LEFT_CAP + IN_CAP;
const MAX_LINES: i32 = 8192; // lines emitted per feed() call

const left = new StaticArray<u8>(LEFT_CAP);
const inBuf = new StaticArray<u8>(IN_CAP);
const outBuf = new StaticArray<u8>(OUT_CAP);
const lenBuf = new StaticArray<i32>(MAX_LINES);

let leftLen: i32 = 0;

/** Bumped whenever the ABI changes; the loader refuses mismatched modules. */
export function version(): i32 {
  return 2;
}

// ---- exported addresses -----------------------------------------------------

export function inPtr(): usize {
  return changetype<usize>(inBuf);
}
export function outPtr(): usize {
  return changetype<usize>(outBuf);
}
export function lenPtr(): usize {
  return changetype<usize>(lenBuf);
}

export function inCap(): i32 {
  return IN_CAP;
}
export function outCap(): i32 {
  return OUT_CAP;
}
export function maxLines(): i32 {
  return MAX_LINES;
}
export function leftCap(): i32 {
  return LEFT_CAP;
}

/** Bytes currently held as an incomplete trailing line. */
export function pending(): i32 {
  return leftLen;
}

export function reset(): void {
  leftLen = 0;
}

/**
 * Append `len` bytes from the input buffer and extract complete lines.
 *
 * Returns the number of lines written (lengths in lenBuf, bytes packed
 * back-to-back in outBuf), or:
 *   -1  input length out of range
 *   -2  carry buffer would overflow (a single line exceeded LEFT_CAP)
 *
 * When the return value equals MAX_LINES there may be more complete lines
 * still buffered; the caller drains them by calling `feed(0)` until it
 * returns less than MAX_LINES. This is what keeps a burst of thousands of
 * small SSE frames from overrunning the length table.
 */
export function feed(len: i32): i32 {
  if (len < 0 || len > IN_CAP) return -1;
  if (leftLen + len > LEFT_CAP) return -2;

  for (let i: i32 = 0; i < len; i++) {
    left[leftLen + i] = inBuf[i];
  }
  const total: i32 = leftLen + len;

  let w: i32 = 0;
  let count: i32 = 0;
  let start: i32 = 0;

  for (let j: i32 = 0; j < total; j++) {
    if (left[j] != 10 /* \n */) continue;

    let end: i32 = j;
    if (end > start && left[end - 1] == 13 /* \r */) end--;
    const lineLen: i32 = end - start;

    // Never write past the output buffer or the length table.
    if (count >= MAX_LINES || w + lineLen > OUT_CAP) break;

    for (let k: i32 = 0; k < lineLen; k++) {
      outBuf[w + k] = left[start + k];
    }
    lenBuf[count] = lineLen;
    w += lineLen;
    count++;
    start = j + 1;
  }

  // Compact whatever was not consumed back to the front of the carry.
  for (let r: i32 = start; r < total; r++) {
    left[r - start] = left[r];
  }
  leftLen = total - start;

  return count;
}

/**
 * Emit the carried partial line as a final line and clear the carry.
 *
 * Streams that end without a trailing newline previously dropped their last
 * frame entirely — for Ollama that is the frame carrying `done: true`, i.e.
 * the tool calls. Returns the byte length written to outBuf, or 0.
 */
export function flush(): i32 {
  if (leftLen <= 0) return 0;
  const n: i32 = leftLen <= OUT_CAP ? leftLen : OUT_CAP;
  for (let i: i32 = 0; i < n; i++) {
    outBuf[i] = left[i];
  }
  lenBuf[0] = n;
  leftLen = 0;
  return n;
}

/** FNV-1a 32-bit over `len` bytes at `ptr`. */
export function hash(ptr: usize, len: i32): u32 {
  let h: u32 = 2166136261;
  for (let i: i32 = 0; i < len; i++) {
    h ^= load<u8>(ptr + (i as usize));
    h *= 16777619;
  }
  return h;
}
