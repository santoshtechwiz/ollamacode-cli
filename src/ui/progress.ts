import ora, { type Ora } from 'ora';
import { dim } from './ansi';

export interface Progress {
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  warn(text?: string): void;
  stop(): void;
}

interface ProgressOptions<T = unknown> {
  /** Persisted on success. A function derives it from the result (e.g. counts). */
  successText?: string | ((result: T) => string);
  failText?: string;
}

class OraProgress implements Progress {
  constructor(private spinner: Ora) {}

  update(text: string): void {
    this.spinner.text = text;
  }

  succeed(text?: string): void {
    if (text !== undefined) this.spinner.succeed(text);
    else this.spinner.succeed();
  }

  fail(text?: string): void {
    if (text !== undefined) this.spinner.fail(text);
    else this.spinner.fail();
  }

  warn(text?: string): void {
    if (text !== undefined) this.spinner.warn(text);
    else this.spinner.warn();
  }

  stop(): void {
    this.spinner.stop();
  }
}

class NoopProgress implements Progress {
  update(): void {}
  succeed(): void {}
  fail(): void {}
  warn(): void {}
  stop(): void {}
}

// Ora on stderr only; chat turns never call withProgress (Ink owns screen).
function progressEnabled(): boolean {
  if (!process.stderr.isTTY) return false;
  if (process.env.CI) return false;
  if (process.env.TERM === 'dumb') return false;
  if (process.env.OLLAMACODE_NO_SPINNER === '1') return false;
  return true;
}

function startProgress(label: string): Progress {
  if (!progressEnabled()) return new NoopProgress();
  const spinner = ora({ text: dim(label), stream: process.stderr });
  spinner.start();
  return new OraProgress(spinner);
}

// Success persists only with successText; failures only with failText.
export async function withProgress<T>(
  label: string,
  fn: (p: Progress) => Promise<T>,
  opts: ProgressOptions<T> = {}
): Promise<T> {
  const progress = startProgress(label);
  try {
    const result = await fn(progress);
    const text =
      typeof opts.successText === 'function' ? opts.successText(result) : opts.successText;
    if (text !== undefined) progress.succeed(text);
    else progress.stop();
    return result;
  } catch (err) {
    if (opts.failText !== undefined) progress.fail(opts.failText);
    else progress.stop();
    throw err;
  }
}
