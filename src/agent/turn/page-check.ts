// The page step of agent.beforeDone: the work opened in a browser the way the person will open it, with check_page.
// A build that passes says nothing about a page that throws in the browser, a request that fails, or a layout that
// scrolls sideways on a phone. The address comes from the operating system (the port the dev server listens on), never
// from what anyone guessed or printed.

import path from 'node:path';
import { TOOL_ERROR_CODE, TOOL_NAME } from '../../protocol';
import { listeningPorts } from '../../tool/process/analysis/listening-ports';
import { pageFiles } from './check-plan';
import type { StackInfo, ToolResult } from '../../types';
import type { ToolExecutor } from '../../tool/execution/executor';
import type { TurnCallbacks } from './turn';

/** How long a dev server that started may take to listen on a port before the page is left unchecked. */
const LISTEN_WAIT_MS = 30_000;
const LISTEN_POLL_MS = 1_000;
/** Changed .html files opened, at most: each one is four browser loads. */
const MAX_PAGE_FILES = 3;

/** A background job as the session holds it. */
interface Job {
  cwd: string;
  pid?: number;
  exited?: boolean;
  error?: string;
}

export interface PageRun {
  /** The call made, as the model and the person see it. */
  tool: string;
  args: Record<string, unknown>;
  label: string;
  result: ToolResult;
  passed: boolean;
  unfinished: boolean;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

/** The ports a job listens on, waiting while it is still starting. null: the system could not say. */
async function portsOnceListening(job: Job, signal?: AbortSignal): Promise<number[] | null> {
  const until = Date.now() + LISTEN_WAIT_MS;
  for (;;) {
    const ports = await listeningPorts(job.pid);
    if (ports === null || ports.length > 0 || job.exited || signal?.aborted || Date.now() >= until) return ports;
    await sleep(LISTEN_POLL_MS, signal);
  }
}

const unfinished = (label: string, why: string): PageRun => ({
  tool: TOOL_NAME.EXEC_SHELL,
  args: {},
  label,
  result: { ok: false, kind: 'none', error: why },
  passed: false,
  unfinished: true,
});

const UNCHECKED = new Set<string>([TOOL_ERROR_CODE.ENOTSUPPORTED, TOOL_ERROR_CODE.ETIMEDOUT, TOOL_ERROR_CODE.ECANCELLED]);

/** check_page's verdict: a script error, a failed request or sideways scrolling fails it; advice does not. */
function verdict(label: string, args: Record<string, unknown>, result: ToolResult): PageRun {
  // No browser here (playwright-core or Chromium missing), or no time left: the page is unchecked, not broken. A page
  // that could not be opened at all is broken.
  if (!result.ok) return { tool: 'check_page', args, label, result, passed: false, unfinished: UNCHECKED.has(String(result.code)) };
  const findings = ((result.data as { findings?: Array<{ severity?: string }> } | undefined)?.findings ?? []);
  return { tool: 'check_page', args, label, result, passed: !findings.some((f) => f.severity === 'error'), unfinished: false };
}

/**
 * Check the pages of one project folder. A web project's page is served by its dev server: the one this session
 * already runs in that folder, or one started now in the background, where it stays for the person to open (and is
 * stopped with ocode). A site with no dev server is checked through its changed .html files.
 */
export async function checkPages({ root, folder, files, stacks, jobs, toolRunner, callbacks, signal }: {
  root: string;
  /** Workspace-relative project folder ('' for the root), and the changed files inside it. */
  folder: string;
  files: string[];
  stacks: StackInfo[];
  jobs?: Map<string, Job>;
  toolRunner: ToolExecutor;
  callbacks: TurnCallbacks;
  signal?: AbortSignal;
}): Promise<PageRun[]> {
  const call = async (name: string, args: Record<string, unknown>) => {
    callbacks.onToolStart?.(name, args);
    const { result } = await toolRunner.run(name, args, { signal, approve: async () => true });
    callbacks.onToolResult?.(name, args, result);
    return result;
  };

  const serving = stacks.find((stack) => stack.dev?.length);
  if (!serving?.dev) {
    const runs: PageRun[] = [];
    for (const file of pageFiles(files).slice(0, MAX_PAGE_FILES)) {
      if (signal?.aborted) break;
      const args = { path: path.posix.join(folder, file) };
      runs.push(verdict(`check_page ${args.path}`, args, await call('check_page', args)));
    }
    return runs;
  }

  const cwd = path.resolve(root, folder);
  const running = [...(jobs?.values() ?? [])].find((job) => !job.exited && !job.error && path.resolve(job.cwd) === cwd);
  let job = running;
  if (!job) {
    const command = serving.dev.map((a) => (/^[\w@./:=-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
    const args = folder ? { command, cwd: folder, background: true } : { command, background: true };
    const started = await call(TOOL_NAME.EXEC_SHELL, args);
    const id = (started.data as { id?: string } | undefined)?.id;
    job = id ? jobs?.get(id) : undefined;
    // A server that would not start (its port taken, another dev server already running in the project) says nothing
    // about the work: the page is unchecked, and the person sees why in the tool line above.
    if (!started.ok || !job) return [{ tool: TOOL_NAME.EXEC_SHELL, args, label: command, result: started, passed: false, unfinished: true }];
  }
  const ports = await portsOnceListening(job, signal);
  if (signal?.aborted) return [];
  if (!ports?.length) {
    return [unfinished('page check', ports === null
      ? 'ocode could not ask the system which port the dev server listens on, so the page was not opened.'
      : `the dev server did not listen on any port within ${LISTEN_WAIT_MS / 1000}s, so the page was not opened.`)];
  }
  const args = { url: `http://localhost:${ports[0]}/` };
  return [verdict(`check_page ${args.url}`, args, await call('check_page', args))];
}
