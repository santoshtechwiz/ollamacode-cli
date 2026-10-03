import { spawn } from 'node:child_process';
import path from 'node:path';
import { logger } from '../core/logger';
import { killProcessTreeAndWait } from '../env/process/index';

const PROTOCOL_VERSION = '2024-11-05';

const WINDOWS_SHIM_COMMANDS = new Set(['npm', 'npx', 'pnpm', 'yarn', 'tsc', 'corepack']);

function baseCommand(command: string): string {
  return path.basename(String(command ?? '')).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
}

function needsWindowsShell(command: string): boolean {
  if (process.platform !== 'win32') return false;
  return WINDOWS_SHIM_COMMANDS.has(baseCommand(command));
}

/** Launchers that may download the server before running it. */
const PACKAGE_RUNNERS = new Set(['npx', 'pnpm', 'pnpx', 'yarn', 'bunx', 'uvx', 'pipx', 'corepack']);

function isPackageRunner(command: string): boolean {
  return PACKAGE_RUNNERS.has(baseCommand(command));
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: any;
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
  }

  /** Restarts a server gets after it stops, so one that crashes on every call does not respawn forever. */
  static MAX_RESTARTS = 2;

  /** How long close() waits for the process to go before giving up on it. */
  static CLOSE_GRACE_MS = 5_000;

  /** A server launched through a package-manager shim may have to *fetch itself* first, and that is not a hang. */
  static COLD_START_GRACE_MS = 90_000;

  async connect(timeoutMs?: number) {
    this.dead = null;
    this.buffer = '';
    this.usesShell = needsWindowsShell(this.cfg.command);
    const budget = timeoutMs ?? (isPackageRunner(this.cfg.command) ? McpClient.COLD_START_GRACE_MS : 15_000);
    const child = spawn(this.cfg.command, this.cfg.args ?? [], {
      env: this.cfg.env ? { ...process.env, ...this.cfg.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: this.usesShell,
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => logger.debug(`mcp[${this.name}] stderr: ${chunk.trim()}`));

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
      stop(new Error(`mcp server "${this.name}" stopped (exit code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''})`));
      settle();
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
        clientInfo: { name: 'ollamacode', version: '0.1.0' },
      },
      budget
    );
    this._notify('notifications/initialized', {});
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this._request('tools/list', {});
    return Array.isArray(res?.tools) ? res.tools : [];
  }

  async callTool(toolName: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<{ text: string; isError: boolean; }> {
    const res = await this._request('tools/call', { name: toolName, arguments: args ?? {} }, timeoutMs);
    const content = Array.isArray(res?.content) ? res.content : [];
    const text = content
      .map((c: { type?: string; text?: string; } | null) => (c && c.type === 'text' ? String(c.text ?? '') : c ? JSON.stringify(c) : ''))
      .filter(Boolean)
      .join('\n');
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

  _request(method: string, params: any, timeoutMs: number = 15_000): Promise<any> {
    // A server that has stopped cannot answer: say so now rather than wait out the timeout.
    if (this.dead) return Promise.reject(this.dead);
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp "${this.name}" ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v: unknown) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e: unknown) => {
          clearTimeout(timer);
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

  _onData(chunk: string) {
    this.buffer += chunk;
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
      pending.reject(new Error(msg.error.message ?? `mcp "${this.name}" error ${msg.error.code ?? ''}`));
    } else {
      pending.resolve(msg.result);
    }
  }
}

