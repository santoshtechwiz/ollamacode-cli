/** ToolExecutor — single execution entry point. */

import { ToolRuntime as BaseRuntime } from '../execution/runtime';
import { createWorkspace as workspaceFallback } from '../../agent/workspace/manager';
import { createInvalidCallMemo } from '../../agent/router/memo';
import { isCancel } from '../../core/errors';
import { logger } from '../../core/logger';
import { fail } from './tool-result';
import { TOOL_ERROR_CODE } from '../../protocol';
import { CancelError } from '../../core/errors';

const DEFAULT_TOOL_TIMEOUT_MS = 600_000;
/** How long a call runs before the person is asked whether to keep waiting, and again after each "keep waiting". */
const CHECK_IN_MS = 120_000;
const KEEP_WAITING = 'Keep waiting';
const STOP_IT = 'Stop it';

interface ToolExecutorOptions {
  root: string;
  workspace?: any;
  state?: any;
  timeoutMs?: number;
  approve?: any;
  ask?: any;
  onCommandOutput?: any;
  registry?: import('../execution/registry.ts').ToolRegistry;
}

export class ToolExecutor {
  private runtime: BaseRuntime;
  private root: string;
  private defaultWorkspace: any;
  private defaultState: any;
  private timeoutMs: number;
  private approve: any;
  private ask: any;
  private onCommandOutput: any;
  private memo: any;

  constructor(opts: ToolExecutorOptions) {
    this.runtime = new BaseRuntime(opts.registry);
    this.root = opts.root;
    this.defaultWorkspace = opts.workspace;
    this.defaultState = opts.state;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.approve = opts.approve;
    this.ask = opts.ask;
    this.onCommandOutput = opts.onCommandOutput;
    this.memo = createInvalidCallMemo();
  }

  async run(
    name: string,
    args: any,
    overrides: { signal?: AbortSignal; timeoutMs?: number; approve?: any; delegate?: import('../../agent/subagent/runner.ts').DelegateFn } = {},
  ): Promise<{ result: import('../../types.ts').ToolResult; timedOut: boolean; durationMs: number }> {
    const startedAt = Date.now();
    const signal = overrides.signal;
    if (signal?.aborted) throw new CancelError();

    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    // Two clocks run only while the tool itself runs: the time limit and the "still running?" check-in.
    // While a person is being asked (the approval, or the tool's own question) both stand still, so a
    // second prompt never opens over one the person is still reading.
    const timeoutMs = overrides.timeoutMs ?? this.timeoutMs;
    // With someone to ask, the check-in is the limit: "Keep waiting" means keep waiting, so no clock kills the tool
    // after the person chose to wait. The time limit is for a run nobody can answer.
    const limited = Number.isFinite(timeoutMs) && timeoutMs > 0 && typeof this.ask !== 'function';
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let limitLeftMs = timeoutMs;
    let runningSince = Date.now();
    let ranMs = 0;

    // Only a live chat can answer; a piped run keeps the plain timeout.
    const finished = new AbortController();
    let stoppedAfterMs = 0;
    let checkIn: ReturnType<typeof setTimeout> | undefined;
    const scheduleCheckIn = () => {
      if (typeof this.ask !== 'function') return;
      checkIn = setTimeout(async () => {
        const waited = ranMs + Date.now() - runningSince;
        const what = this.runtime.registry.find(name)?.preview?.(args) ?? name;
        let answer = '';
        try {
          answer = String(await this.ask!(`Still running after ${Math.round(waited / 60_000)} min — ${what}`, [KEEP_WAITING, STOP_IT], { signal: finished.signal }));
        } catch {
          return;
        }
        if (finished.signal.aborted || controller.signal.aborted) return;
        if (answer === STOP_IT) {
          stoppedAfterMs = waited;
          controller.abort();
        } else {
          scheduleCheckIn();
        }
      }, CHECK_IN_MS);
    };

    const startClocks = () => {
      runningSince = Date.now();
      if (limited) {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, limitLeftMs);
      }
      scheduleCheckIn();
    };
    const stopClocks = () => {
      const ran = Date.now() - runningSince;
      ranMs += ran;
      limitLeftMs = Math.max(0, limitLeftMs - ran);
      if (timer) clearTimeout(timer);
      if (checkIn) clearTimeout(checkIn);
      timer = checkIn = undefined;
    };
    let asking = 0;
    const whileAsking = <F extends (...a: any[]) => Promise<any>>(fn: F | undefined): F | undefined =>
      fn && ((async (...a: any[]) => {
        if (asking++ === 0) stopClocks();
        try {
          return await fn(...a);
        } finally {
          if (--asking === 0 && !finished.signal.aborted) startClocks();
        }
      }) as F);
    startClocks();

    // Ensure workspace/state/memo defaults match legacy ToolRunner behavior
    const root = this.root ?? this.defaultWorkspace?.root ?? (overrides as any)?.root ?? process.cwd();
    const workspace = this.defaultWorkspace ?? workspaceFallback({ root, granted: this.defaultState?.grantedRoots ?? [] });
    const state = this.defaultState;
    const ctx = {
      root,
      cwd: root,
      ws: workspace,
      state,
      memo: this.memo,
      signal: controller.signal,
      log: logger,
      ask: whileAsking(this.ask),
      onCommandOutput: this.onCommandOutput,
      approve: whileAsking(overrides.approve ?? this.approve),
      delegate: overrides.delegate,
    };

    try {
      const approve = ctx.approve;
      const result = await this.runtime.run(name, args, ctx as any, approve);
      if (stoppedAfterMs) return { result: stoppedResult(name, stoppedAfterMs, result), timedOut: false, durationMs: Date.now() - startedAt };
      if (timedOut) return { result: timeoutResult(name, timeoutMs, result), timedOut: true, durationMs: Date.now() - startedAt };
      return { result, timedOut: false, durationMs: Date.now() - startedAt };
    } catch (err) {
      if (stoppedAfterMs) return { result: stoppedResult(name, stoppedAfterMs), timedOut: false, durationMs: Date.now() - startedAt };
      if (timedOut) return { result: timeoutResult(name, timeoutMs), timedOut: true, durationMs: Date.now() - startedAt };
      if (signal?.aborted || isCancel(err)) throw new CancelError();
      logger.debug(`tool ${name} threw unexpectedly:`, err);
      return {
        result: fail(`Unexpected internal error: ${(err as Error)?.message ?? String(err)}`, { code: TOOL_ERROR_CODE.EINTERNAL }),
        timedOut: false,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (checkIn) clearTimeout(checkIn);
      // Withdraws a keep-waiting question still on screen.
      finished.abort();
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

/** What the tool had produced when it was ended, if it said anything: a stopped command's output so far. */
function soFar(result?: import('../../types.ts').ToolResult): { display?: string; data?: unknown } {
  return result?.display ? { display: result.display, ...(result.data !== undefined ? { data: result.data } : {}) } : {};
}

function stoppedResult(name: string, waitedMs: number, result?: import('../../types.ts').ToolResult): import('../../types.ts').ToolResult {
  return fail(`${name} was stopped by the user after ${Math.round(waitedMs / 60_000)} min`, {
    code: TOOL_ERROR_CODE.ECANCELLED,
    hint: 'The user chose not to wait for it. Read what it printed below; do not run it again unchanged.',
    ...soFar(result),
  });
}

function timeoutResult(name: string, timeoutMs: number, result?: import('../../types.ts').ToolResult): import('../../types.ts').ToolResult {
  return fail(`${name} did not finish within ${Math.round(timeoutMs / 1000)}s and was stopped`, {
    code: TOOL_ERROR_CODE.ETIMEDOUT,
    hint: 'Try a narrower call (a smaller path, a shorter command), or a different approach.',
    ...soFar(result),
  });
}
