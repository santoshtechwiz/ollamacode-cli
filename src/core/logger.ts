import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import type { Logger as PinoLogger } from 'pino';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Structured fields carried on every record. Free-form keys allowed. */
export interface LogMeta {
  component?: string;
  sessionId?: string;
  requestId?: string;
  [key: string]: unknown;
}

/** Small internal interface so the provider (pino) can be swapped easily. */
export interface TypedLogger {
  level: LogLevel;
  scope: string;
  file: string | undefined;
  enabled(level: LogLevel): boolean;
  error(message: string, meta?: LogMeta): void;
  error(...parts: unknown[]): void;
  warn(message: string, meta?: LogMeta): void;
  warn(...parts: unknown[]): void;
  info(message: string, meta?: LogMeta): void;
  info(...parts: unknown[]): void;
  debug(message: string, meta?: LogMeta): void;
  debug(...parts: unknown[]): void;
  trace(message: string, meta?: LogMeta): void;
  trace(...parts: unknown[]): void;
  traceBlock(label: string, body: unknown, meta?: LogMeta): void;
  child(scope: string): TypedLogger;
  withContext(ctx: { sessionId?: string; requestId?: string; }): TypedLogger;
  time<T>(label: string, fn: () => Promise<T>): Promise<T>;
}

const LEVELS = ({
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
} as const);

// pino numeric levels for records arriving on the router stream.
const PINO_LEVEL_NUM: Record<string, LogLevel> = {
  '10': 'trace',
  '20': 'debug',
  '30': 'info',
  '40': 'warn',
  '50': 'error',
  '60': 'error',
};

const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

const SECRET_PATTERNS = [
  /\bhf_[A-Za-z0-9]{8,}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/-]{12,}/gi,
  // A value with ( ) or ; is code (`cancellationToken = default);`), not a secret.
  /(("|')?(?:token|api[_-]?key|password|secret|authorization)("|')?\s*[:=]\s*("|')?)([^\s"',}();]{8,})/gi,
];

function redact(text: string): string {
  let out = String(text);
  out = out.replace(SECRET_PATTERNS[0], 'hf_***');
  out = out.replace(SECRET_PATTERNS[1], 'sk-***');
  out = out.replace(SECRET_PATTERNS[2], 'gh*_***');
  out = out.replace(SECRET_PATTERNS[3], '$1***');
  out = out.replace(SECRET_PATTERNS[4], '$1***');
  return out;
}

function format(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    const cause = (value as { cause?: unknown; }).cause;
    const base = `${value.name}: ${value.message}`;
    const withCode = (value as { code?: string; }).code
      ? `${base} [${(value as { code?: string; }).code}]`
      : base;
    return cause ? `${withCode}\n  caused by: ${format(cause)}` : withCode;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function resolveLevel(envLevel?: LogLevel): LogLevel {
  const raw = String(envLevel ?? process.env.OLLAMACODE_LOG ?? '').toLowerCase();
  if (raw in LEVELS) return (raw as LogLevel);
  if (raw === '1' || raw === 'true') return 'debug';
  return 'warn';
}

function isPlainRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  if (v instanceof Error || Array.isArray(v)) return false;
  return Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null;
}

/** Split `debug(msg, meta)` from the legacy variadic `debug(...parts)`. */
function splitArgs(parts: unknown[]): { msg: string; meta: LogMeta; } {
  if (parts.length === 2 && typeof parts[0] === 'string' && isPlainRecord(parts[1])) {
    return { msg: parts[0], meta: parts[1] as LogMeta };
  }
  return { msg: parts.map(format).join(' '), meta: {} };
}

/** Where a diagnostic goes while something else owns the terminal. */
export type LogSink = (level: LogLevel, line: string) => void;

let sink: LogSink | null = null;
let inSink = false;

export function setLogSink(next: LogSink | null): void {
  sink = next;
}

export interface LoggerOptions {
  level?: LogLevel;
  scope?: string;
  file?: string;
  sessionId?: string;
  requestId?: string;
}

const REDACT_PATHS = [
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.authorization',
  '*.HF_TOKEN',
  '*.hf_token',
  'token',
  'apiKey',
  'password',
  'secret',
];

class Logger implements TypedLogger {
  level: LogLevel;
  scope: string;
  file: string | undefined;
  _fd: number | null;
  _sessionId: string | undefined;
  _requestId: string | undefined;
  _pino: PinoLogger;

  constructor({ level, scope = '', file, sessionId, requestId }: LoggerOptions = {}) {
    this.level = resolveLevel(level);
    this.scope = scope;
    this.file = file;
    this._fd = null;
    this._sessionId = sessionId;
    this._requestId = requestId;
    this._pino = this._buildPino();
  }

  _buildPino(extra: Record<string, unknown> = {}): PinoLogger {
    const bindings: Record<string, unknown> = { ...extra };
    if (this.scope) bindings.component = this.scope;
    if (this._sessionId) bindings.sessionId = this._sessionId;
    if (this._requestId) bindings.requestId = this._requestId;
    try {
      const base = pino(
        {
          level: this.level === 'silent' ? 'silent' : this.level,
          redact: { paths: REDACT_PATHS, censor: '***' },
          base: bindings,
        },
        { write: (chunk: string) => this._routeChunk(chunk) }
      );
      return base;
    } catch {
      // pino must never break construction; fall back to a noop-shaped logger and let the direct writer below still deliver the line.
      return pino({ level: 'silent' });
    }
  }

  /** pino destination: one JSON record per line -> human presentation. */
  _routeChunk(chunk: string): void {
    try {
      const lines = String(chunk).split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        this._present(obj);
      }
    } catch {
      // Logging failures must never crash the agent; drop the record.
    }
  }

  _present(obj: Record<string, unknown>): void {
    try {
      const level = PINO_LEVEL_NUM[String(obj.level)] ?? 'info';
      if (!this.enabled(level)) return;
      const component =
        (typeof obj.component === 'string' && obj.component) || this.scope || '';
      const msg = redact(String((obj.msg as string) ?? ''));
      const scopePrefix = component ? `${component} ` : '';
      // Structured remainder: everything pino carried minus its envelope, and minus the identity bindings.
      const {
        level: _l,
        time: _t,
        pid: _p,
        hostname: _h,
        msg: _m,
        component: _c,
        sessionId,
        requestId,
        ...rest
      } = obj;
      let metaSuffix = '';
      if (rest && Object.keys(rest).length > 0) {
        try {
          metaSuffix = ` ${redact(JSON.stringify(rest))}`;
        } catch {
          metaSuffix = '';
        }
      }
      const body = `${msg}${metaSuffix}`;
      const identity = identitySuffix(sessionId, requestId);
      if (level === 'trace') {
        // File-only by design: stderr belongs to the renderer while Ink draws.
        this._appendFile(level, scopePrefix, body, identity);
        return;
      }
      this._deliver(level, scopePrefix, body, identity);
    } catch {
      // Never let presentation crash the agent.
    }
  }

  /** Single sink → stderr → file path for every non-trace record. */
  _deliver(level: LogLevel, scopePrefix: string, body: string, identity: string = '') {
    // Re-entrancy guard: a sink that logs would call straight back in.
    if (sink && !inSink) {
      inSink = true;
      let delivered = true;
      try {
        sink(level, `${scopePrefix}${body}`);
      } catch {
        delivered = false;
      } finally {
        inSink = false;
      }
      if (delivered) {
        this._appendFile(level, scopePrefix, body, identity);
        return;
      }
    }
    const color = level === 'error' ? RED : level === 'warn' ? YELLOW : DIM;
    const clear = process.stderr.isTTY ? '\x1b[2K\r' : '';
    try {
      process.stderr.write(`${clear}${color}${scopePrefix}${body}${RESET}\n`);
    } catch {
      // stderr may be closed in tests/pipes; the file record below still counts.
    }
    this._appendFile(level, scopePrefix, body, identity);
  }

  child(scope: string): Logger {
    const next = new Logger({
      level: this.level,
      scope: this.scope ? `${this.scope}:${scope}` : scope,
      file: this.file,
      sessionId: this._sessionId,
      requestId: this._requestId,
    });
    next._fd = this._fd;
    return next;
  }

  withContext(ctx: { sessionId?: string; requestId?: string; }): Logger {
    const next = new Logger({
      level: this.level,
      scope: this.scope,
      file: this.file,
      sessionId: ctx.sessionId ?? this._sessionId,
      requestId: ctx.requestId ?? this._requestId,
    });
    next._fd = this._fd;
    return next;
  }

  enabled(level: LogLevel): boolean {
    return LEVELS[level] <= LEVELS[this.level];
  }

  _write(level: LogLevel, parts: unknown[]) {
    if (!this.enabled(level)) return;
    const { msg, meta } = splitArgs(parts);
    const body = redact(msg);
    try {
      const emit = (this._pino as unknown as Record<string, (o: object, m: string) => void>)[level];
      if (typeof emit === 'function') {
        emit.call(this._pino, meta ?? {}, body);
        return;
      }
    } catch {
      // Fall through to the direct writer rather than lose the diagnostic.
    }
    // Fallback path if pino is unavailable: same single deliver path.
    const scope = this.scope ? `${this.scope} ` : '';
    let metaSuffix = '';
    if (meta && Object.keys(meta).length > 0) {
      try {
        metaSuffix = ` ${redact(JSON.stringify(meta))}`;
      } catch {
        metaSuffix = '';
      }
    }
    const line = `${body}${metaSuffix}`;
    if (level === 'trace') {
      this._appendFile(level, scope, line);
      return;
    }
    this._deliver(level, scope, line);
  }

  _appendFile(level: LogLevel, scope: string, body: string, identity: string = '') {
    this._appendRaw(`${new Date().toISOString()} ${level.padEnd(5)} ${scope}${body}${identity}\n`);
  }

  error(...parts: unknown[]) {
    this._write('error', parts);
  }

  warn(...parts: unknown[]) {
    this._write('warn', parts);
  }

  info(...parts: unknown[]) {
    this._write('info', parts);
  }

  debug(...parts: unknown[]) {
    this._write('debug', parts);
  }

  trace(...parts: unknown[]) {
    if (!this.enabled('trace')) return;
    const { msg, meta } = splitArgs(parts);
    const body = redact(msg);
    try {
      this._pino.trace(meta ?? {}, body);
    } catch {
      const scope = this.scope ? `${this.scope} ` : '';
      this._appendFile('trace', scope, body);
    }
  }

  /** A multi-line payload — a whole prompt, a wire body — written to the log file between delimiters. */
  traceBlock(label: string, body: unknown, meta?: LogMeta) {
    if (!this.enabled('trace')) return;
    if (!this.file) return;
    const scope = this.scope ? `${this.scope} ` : '';
    const text = redact(typeof body === 'string' ? body : format(body));
    let metaSuffix = '';
    if (meta && Object.keys(meta).length > 0) {
      try {
        metaSuffix = ` ${redact(JSON.stringify(meta))}`;
      } catch {
        metaSuffix = '';
      }
    }
    const header = `${new Date().toISOString()} trace ${scope}--- ${label} ---${metaSuffix}\n`;
    this._appendRaw(`${header}${text}\n--- /${label} ---\n`);
  }

  _appendRaw(text: string) {
    if (!this.file) return;
    try {
      if (this._fd === null) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        this._fd = fs.openSync(this.file, 'a');
      }
      fs.writeSync(this._fd, text);
    } catch {
      this.file = undefined;
    }
  }

  async time<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (!this.enabled('debug')) return fn();
    const started = Date.now();
    try {
      const result = await fn();
      this.debug(`${label} ok in ${Date.now() - started}ms`);
      return result;
    } catch (err) {
      this.debug(`${label} failed in ${Date.now() - started}ms:`, err);
      throw err;
    }
  }
}

/** The identity tail on a *file* record: `sessionId` and `requestId` as separate, greppable fields. */
function identitySuffix(sessionId: unknown, requestId: unknown): string {
  const parts: string[] = [];
  if (typeof sessionId === 'string' && sessionId) parts.push(`sessionId=${sessionId}`);
  if (typeof requestId === 'string' && requestId) parts.push(`requestId=${requestId}`);
  return parts.length > 0 ? ` [${parts.join(' ')}]` : '';
}

export let logger: TypedLogger = new Logger();

export function configureLogger({ level, toFile = false, homeDir, sessionId, requestId }: { level?: LogLevel; toFile?: boolean; homeDir?: string; sessionId?: string; requestId?: string; } = {}) {
  let file: string | undefined;
  if (toFile && homeDir) {
    const day = new Date().toISOString().slice(0, 10);
    file = path.join(homeDir, 'logs', `ocode-${day}.log`);
  }
  logger = new Logger({ level, file, sessionId, requestId });
  return logger;
}

/** Bind the conversation onto every later log line. */
export function bindSessionContext(ctx: { sessionId?: string; requestId?: string; }): TypedLogger {
  logger = logger.withContext(ctx);
  return logger;
}
