import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { logger } from '../core/logger';
import { CancelError } from '../core/errors';
import { killProcessTreeAndWait } from '../env/process/index';

const PROTOCOL_VERSION = '2024-11-05';

/** ocode's own version, which servers see in the handshake. */
const CLIENT_VERSION: string = (() => {
  try {
    return String(createRequire(import.meta.url)('../../package.json').version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

/** What a server last wrote to stderr, kept so a failure can say why: a missing module, a bad token. */
const STDERR_TAIL_CHARS = 2_000;


const WINDOWS_SHIM_COMMANDS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'tsc', 'corepack']);

function baseCommand(command: string): string {
  return path.basename(String(command ?? '')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

function needsWindowsShell(command: string): boolean {
  if (process.platform !== 'win32') return false;
  return WINDOWS_SHIM_COMMANDS.has(baseCommand(command));
}

/**
 * One argument as cmd.exe reads it. Through the shell Node joins arguments with spaces and quotes nothing, so a path
 * with a space became two arguments and `&` or `|` in one ran a second command.
 */
export function quoteForCmd(arg: string): string {
  const s = String(arg ?? '');
  if (s && !/[\s"&|<>^%()!,;=]/.test(s)) return s;
  // Inside the quotes cmd's & | < > are plain text. Backslashes before a quote are doubled and the quote escaped,
  // the C runtime's rule, so node and npx read the argument back whole.
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** Launchers that may download the server before running it. */
const PACKAGE_RUNNERS = new Set(['npx', 'pnpm', 'pnpx', 'yarn', 'bunx', 'uvx', 'pipx', 'corepack']);

function isPackageRunner(command: string): boolean {
  return PACKAGE_RUNNERS.has(baseCommand(command));
}

/** Longest unknown content block passed through as JSON; past it, only its type is named. */
const UNKNOWN_CONTENT_CHARS = 500;

/** Bytes a base64 string decodes to, in words. */
function sizeOf(base64: unknown): string {
  const bytes = Math.round((String(base64 ?? '').length * 3) / 4);
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

/**
 * One content block as text the model can use. Images, audio and binary resources are named, not inlined: their
 * base64 is noise to a text model and used to fill its context (one screenshot was 200,000 characters).
 */
function describeContent(block: any): string {
  if (!block || typeof block !== 'object') return '';
  switch (block.type) {
    case 'text':
      return String(block.text ?? '');
    case 'image':
    case 'audio':
      return `[${block.type}${block.mimeType ? ` ${block.mimeType}` : ''}, ${sizeOf(block.data)} — not shown as text]`;
    case 'resource': {
      const resource = block.resource ?? {};
      if (typeof resource.text === 'string') return resource.text;
      const parts = [resource.uri, resource.mimeType, resource.blob !== undefined ? sizeOf(resource.blob) : null].filter(Boolean);
      return `[resource ${parts.join(', ')}]`;
    }
    case 'resource_link':
      return `[link ${[block.name, block.uri].filter(Boolean).join(' ')}]`;
    default: {
      const json = JSON.stringify(block);
      return json.length <= UNKNOWN_CONTENT_CHARS ? json : `[${String(block.type ?? 'unknown')} content, ${json.length} characters — not shown]`;
    }
  }
}

/** A JSON-RPC error a server answered with, keeping its code: -32602 (bad arguments) and -32601 (no such method) read differently. */
export class McpError extends Error {
  code: number | undefined;
  data: unknown;
  constructor(server: string, error: { code?: unknown; message?: unknown; data?: unknown }) {
    const code = typeof error?.code === 'number' ? error.code : undefined;
    const known = code !== undefined ? JSON_RPC_ERRORS[code] : undefined;
    super(`mcp "${server}" ${String(error?.message ?? 'error')}${code !== undefined ? ` (${known ? `${known}, ` : ''}code ${code})` : ''}`);
    this.name = 'McpError';
    this.code = code;
    this.data = error?.data;
  }
}

const JSON_RPC_ERRORS: Record<number, string> = {
  [-32700]: 'unparseable request',
  [-32600]: 'invalid request',
  [-32601]: 'no such method',
  [-32602]: 'invalid arguments',
  [-32603]: 'server internal error',
};

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
  /** What the server says about the tool's effects; absent hints mean nothing is claimed. */
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
}

export class McpClient {
  name: any;
  cfg: any;
  child: any;
  usesShell: any;
  pending: any;
  nextId: any;
  buffer: any;
  closed: any;
  /** Why the server can no longer answer: it exited, or it never started. Calls fail at once with this. */
  dead: Error | null;
  /** How many times a dead server was started again this session. */
  restarts: number;
  /** The end of what the server wrote to stderr, for failure messages. */
  stderrTail: string;
  /** A line past MAX_LINE_CHARS was dropped and its rest is still arriving. */
  skipping: boolean;

  constructor(cfg: import('../core/config.ts').McpServerConfig) {
    this.name = cfg.name;
    this.cfg = cfg;
    this.child = null;
    this.usesShell = false;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = null;
    this.dead = null;
    this.restarts = 0;
    this.stderrTail = '';
    this.skipping = false;
  }

  /** Restarts a server gets after it stops, so one that crashes on every call does not respawn forever. */
  static MAX_RESTARTS = 2;

  /** Longest line ocode waits for: past it a server is writing something other than JSON-RPC, and the buffer is dropped. */
  static MAX_LINE_CHARS = 16 * 1024 * 1024;

  /** How long close() waits for the process to go before giving up on it. */
  static CLOSE_GRACE_MS = 5_000;

  /** A server launched through a package-manager shim may have to *fetch itself* first, and that is not a hang. */
  static COLD_START_GRACE_MS = 90_000;

  async connect(timeoutMs?: number) {
    this.dead = null;
    this.buffer = '';
    this.skipping = false;
    this.stderrTail = '';
    this.usesShell = needsWindowsShell(this.cfg.command);
    const budget = timeoutMs ?? (isPackageRunner(this.cfg.command) ? McpClient.COLD_START_GRACE_MS : 15_000);
    const args: string[] = (this.cfg.args ?? []).map(String);
    const child = spawn(this.cfg.command, this.usesShell ? args.map(quoteForCmd) : args, {
      env: this.cfg.env ? { ...process.env, ...this.cfg.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: this.usesShell,
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      logger.debug(`mcp[${this.name}] stderr: ${chunk.trim()}`);
      this.stderrTail = (this.stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    let settle!: () => void;
    this.closed = new Promise<void>((resolve) => {
      settle = resolve;
    });
    // A process replaced by a restart may still exit later: what it does is no longer this connection's news.
    const stop = (err: Error) => {
      if (this.child !== child) return;
      this.dead = err;
      for (const [, p] of this.pending) p.reject(err);
      this.pending.clear();
    };
    child.on('exit', (code, signal) => {
      // What it said on its way out (a missing token, a crash) can still be in the pipe when the exit arrives.
      let reported = false;
      const report = () => {
        if (reported) return;
        reported = true;
        stop(new Error(`mcp server "${this.name}" stopped (exit code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''})${this._stderrNote()}`));
        settle();
      };
      if (child.stderr.readableEnded) return report();
      child.stderr.once('end', report);
      setTimeout(report, 250).unref();
    });
    child.on('error', (err) => {
      stop(err);
      // A command that could not be started never exits: without this, close() waited on it forever.
      if (child.pid === undefined) settle();
    });

    await this._request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'ollamacode', version: CLIENT_VERSION },
      },
      budget
    );
    this._notify('notifications/initialized', {});
  }

  /** Pages a tool listing may run to before ocode stops asking: a server that always offers another is not followed forever. */
  static MAX_TOOL_PAGES = 100;

  /** Every tool the server lists, following its pages: tools past the first page used to be dropped. */
  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < McpClient.MAX_TOOL_PAGES; page++) {
      const res = await this._request('tools/list', cursor ? { cursor } : {});
      if (Array.isArray(res?.tools)) tools.push(...res.tools);
      cursor = typeof res?.nextCursor === 'string' && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs = 60_000, signal?: AbortSignal): Promise<{ text: string; isError: boolean; }> {
    const res = await this._request('tools/call', { name: toolName, arguments: args ?? {} }, timeoutMs, signal);
    const content = Array.isArray(res?.content) ? res.content : [];
    let text = content.map(describeContent).filter(Boolean).join('\n');
    // Newer servers may answer with structured data alone.
    if (!text && res?.structuredContent !== undefined) text = JSON.stringify(res.structuredContent);
    return { text, isError: Boolean(res?.isError) };
  }

  async close() {
    if (!this.child) return;
    this.child.stdin?.end();
    if (this.child.pid !== undefined && !this.dead) {
      try {
        await killProcessTreeAndWait(this.child);
      } catch {}
    }
    // Never wait without end: a process that will not go is left to the exit handler, not allowed to hang the caller.
    await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, McpClient.CLOSE_GRACE_MS).unref())]);
  }

  /** Start a server that stopped again, a bounded number of times; false when it has had its restarts. */
  async restart(): Promise<boolean> {
    if (this.restarts >= McpClient.MAX_RESTARTS) return false;
    this.restarts += 1;
    await this.close().catch(() => {});
    this.pending = new Map();
    await this.connect();
    return true;
  }

  _request(method: string, params: any, timeoutMs: number = 15_000, signal?: AbortSignal): Promise<any> {
    // A server that has stopped cannot answer: say so now rather than wait out the timeout.
    if (this.dead) return Promise.reject(this.dead);
    if (signal?.aborted) return Promise.reject(new CancelError());
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      // The person stopped the turn: stop waiting, and tell the server so it can stop working.
      const onAbort = () => {
        this.pending.delete(id);
        clearTimeout(timer);
        this._notify('notifications/cancelled', { requestId: id, reason: 'cancelled by the person' });
        reject(new CancelError());
      };
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`mcp "${this.name}" ${method} timed out after ${timeoutMs}ms${this._stderrNote()}`));
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (v: unknown) => {
          done();
          resolve(v);
        },
        reject: (e: unknown) => {
          done();
          reject(e);
        },
      });
      this._write(payload);
    });
  }

  _notify(method: string, params: any) {
    this._write({ jsonrpc: '2.0', method, params });
  }

  _write(payload: any) {
    if (!this.child?.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  /** The last lines the server wrote to stderr, as a suffix for a failure message; empty when it wrote none. */
  _stderrNote(): string {
    const lines = this.stderrTail.trim().split(/\r?\n/).slice(-5).join('\n').trim();
    return lines ? `; its last output:\n${lines}` : '';
  }

  _onData(chunk: string) {
    if (this.skipping) {
      // The rest of a line already dropped: nothing in it can be read.
      const end = chunk.indexOf('\n');
      if (end === -1) return;
      this.skipping = false;
      chunk = chunk.slice(end + 1);
    }
    this.buffer += chunk;
    if (this.buffer.length > McpClient.MAX_LINE_CHARS && !this.buffer.includes('\n')) {
      logger.warn(`mcp[${this.name}] wrote more than ${McpClient.MAX_LINE_CHARS} characters with no line end; dropped`);
      this.buffer = '';
      this.skipping = true;
      return;
    }
    for (let idx = this.buffer.indexOf('\n'); idx !== -1; idx = this.buffer.indexOf('\n')) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this._onMessage(line);
    }
  }

  /** Answer what the server asks: a ping is answered, anything else is declined, so the server never waits on us. */
  _onServerMessage(msg: { id?: unknown; method: string }) {
    if (msg.id === undefined || msg.id === null) return;
    if (msg.method === 'ping') {
      this._write({ jsonrpc: '2.0', id: msg.id, result: {} });
      return;
    }
    logger.debug(`mcp[${this.name}] declined server request ${msg.method}`);
    this._write({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `ocode does not support ${msg.method}` } });
  }

  _onMessage(line: string) {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.debug(`mcp[${this.name}] non-JSON line: ${line}`);
      return;
    }
    // Anything with a method comes from the server: a request when it has an id, a notification when not. Never a
    // reply to ours, even when its id happens to match one of ours, since each side numbers its own requests.
    if (typeof msg.method === 'string') {
      this._onServerMessage(msg);
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new McpError(this.name, msg.error));
    } else {
      pending.resolve(msg.result);
    }
  }
}

