import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { logger } from '../logger';

const ABI_VERSION = 2;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function fnv1aJs(bytes: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

class WasmEngine {
  exps: any;
  mem: any;
  inPtr: any;
  outPtr: any;
  lenPtr: any;
  inCap: any;
  maxLines: any;

  constructor(instance: WebAssembly.Instance) {
    const e = (instance.exports as any);
    this.exps = e;
    this.mem = e.memory;

    this.inPtr = e.inPtr();
    this.outPtr = e.outPtr();
    this.lenPtr = e.lenPtr();
    this.inCap = e.inCap();
    this.maxLines = e.maxLines();
  }

  reset() {
    this.exps.reset();
  }

  feedStream(chunk: string): string[] {
    return this.feedBytes(encoder.encode(chunk));
  }

  feedBytes(bytes: Uint8Array): string[] {
    const out: any[] = [];
    for (let offset = 0; offset < bytes.length || offset === 0; offset += this.inCap) {
      const slice = bytes.subarray(offset, offset + this.inCap);
      this._feedOnce(slice, out);
      if (slice.length === 0) break;
    }
    return out;
  }

  _feedOnce(slice: Uint8Array, out: string[]) {
    new Uint8Array(this.mem.buffer).set(slice, this.inPtr);
    let n = this.exps.feed(slice.length);
    this._collect(n, out);

    while (n === this.maxLines) {
      n = this.exps.feed(0);
      this._collect(n, out);
    }
  }

  _collect(n: number, out: string[]) {
    if (n === -1) throw new Error('wasm engine: chunk length out of range');
    if (n === -2) {
      throw new Error(
        `wasm engine: line exceeds ${this.exps.leftCap()} bytes without a newline`
      );
    }
    if (n <= 0) return;
    const view = new DataView(this.mem.buffer);
    const u8 = new Uint8Array(this.mem.buffer);
    let cursor = this.outPtr;
    for (let i = 0; i < n; i++) {
      const len = view.getInt32(this.lenPtr + i * 4, true);
      out.push(decoder.decode(u8.subarray(cursor, cursor + len)));
      cursor += len;
    }
  }

  flush(): string[] {
    const n = this.exps.flush();
    if (n <= 0) return [];
    const u8 = new Uint8Array(this.mem.buffer);
    let text = decoder.decode(u8.subarray(this.outPtr, this.outPtr + n));
    if (text.endsWith('\r')) text = text.slice(0, -1);
    return [text];
  }

  hashString(str: string): string {
    const bytes = encoder.encode(str);
    if (bytes.length > this.inCap) {
      return fnv1aJs(bytes).toString(16).padStart(8, '0');
    }
    new Uint8Array(this.mem.buffer).set(bytes, this.inPtr);
    return (this.exps.hash(this.inPtr, bytes.length) >>> 0).toString(16).padStart(8, '0');
  }
}

class FallbackEngine {
  carry: any;

  constructor() {
    this.carry = '';
  }

  reset() {
    this.carry = '';
  }

  feedStream(chunk: string): string[] {
    const data = this.carry + chunk;
    const parts = data.split('\n');
    this.carry = parts.pop() ?? '';
    return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  }

  feedBytes(bytes: Uint8Array): string[] {
    return this.feedStream(decoder.decode(bytes));
  }

  flush(): string[] {
    if (!this.carry) return [];
    const text = this.carry.endsWith('\r') ? this.carry.slice(0, -1) : this.carry;
    this.carry = '';
    return [text];
  }

  hashString(str: string): string {
    return fnv1aJs(encoder.encode(str)).toString(16).padStart(8, '0');
  }
}

let modulePromise: any = null;

function compileModule(): Promise<WebAssembly.Module | null> {
  if (modulePromise) return modulePromise;
  modulePromise = (async () => {
    const wasmPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'engine.wasm');
    try {
      const bytes = await fs.readFile(wasmPath);
      return await WebAssembly.compile(bytes);
    } catch (err) {
      logger.debug(`wasm engine unavailable, using JS fallback: ${ (err as Error).message}`);
      return null;
    }
  })();
  return modulePromise;
}

function makeImports() {
  return {
    env: {
      abort(_msg: number, _file: number, line: number, column: number) {
        throw new Error(`wasm abort at ${line}:${column}`);
      },
    },
  };
}

export async function createEngine({ preferWasm = true }: any = {}): Promise<WasmEngine | FallbackEngine> {
  if (preferWasm) {
    const mod = await compileModule();
    if (mod) {
      try {
        const instance = await WebAssembly.instantiate(mod, makeImports());
        const exports = (instance.exports as any);
        const abi = typeof exports.version === 'function' ? exports.version() : 0;
        if (abi !== ABI_VERSION) {
          logger.debug(
            `wasm engine ABI ${abi} != expected ${ABI_VERSION}; rebuild with "npm run build:wasm". Using JS fallback.`
          );
        } else {
          return new WasmEngine(instance);
        }
      } catch (err) {
        logger.debug(
          `wasm engine instantiation failed, using JS fallback: ${ (err as Error).message}`
        );
      }
    }
  }
  return new FallbackEngine();
}

