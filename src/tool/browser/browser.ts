import { TOOL_ERROR_CODE } from '../../protocol';
import { ToolError } from '../core/tool-error';

/**
 * A headless browser, loaded on first use. playwright-core is an optional dependency and ships no browser of its own,
 * so an install without it (or without any browser) still works and only page checks say they are unavailable.
 */

/** The part of Playwright ocode uses, typed here so the code type-checks whether or not the optional package is installed. */
export interface BrowserPage {
  goto(url: string, opts: { waitUntil: 'load'; timeout: number }): Promise<unknown>;
  waitForLoadState(state: 'networkidle', opts: { timeout: number }): Promise<void>;
  evaluate<T>(fn: string | ((arg: any) => T | Promise<T>), arg?: unknown): Promise<T>;
  addScriptTag(opts: { content: string }): Promise<unknown>;
  on(event: string, listener: (value: any) => void): void;
}
export interface BrowserContext {
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}
export interface Browser {
  newContext(opts: { viewport: { width: number; height: number } }): Promise<BrowserContext>;
  close(): Promise<void>;
}

// Named through a variable so the compiler does not try to resolve the optional package.
const PLAYWRIGHT_PACKAGE = 'playwright-core';

/**
 * Where to find a browser, tried in order: the one Playwright installed (`npx playwright install chromium`), then a
 * Chrome or Edge already on the machine. One more way to find a browser is one more entry here.
 */
const LAUNCH_CANDIDATES: ReadonlyArray<{ channel?: string }> = Object.freeze([{}, { channel: 'chrome' }, { channel: 'msedge' }]);

function isMissingModule(err: unknown, name: string): boolean {
  const code = String((err as { code?: string })?.code);
  return /MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/.test(code) && String((err as Error)?.message).includes(name);
}

export async function launchBrowser(): Promise<Browser> {
  let chromium: { launch(opts: Record<string, unknown>): Promise<Browser> };
  try {
    const mod: any = await import(PLAYWRIGHT_PACKAGE);
    chromium = (mod.chromium ?? mod.default?.chromium);
  } catch (err) {
    if (!isMissingModule(err, PLAYWRIGHT_PACKAGE)) throw err;
    throw new ToolError('Page checks are unavailable: the optional playwright-core package is not installed', {
      code: TOOL_ERROR_CODE.ENOTSUPPORTED,
      hint: 'Tell the user that check_page needs playwright-core (npm install playwright-core) and a browser (npx playwright install chromium).',
    });
  }
  const errors: string[] = [];
  for (const candidate of LAUNCH_CANDIDATES) {
    try {
      return await chromium.launch({ headless: true, ...candidate });
    } catch (err) {
      errors.push(String((err as Error)?.message ?? err).split('\n')[0]);
    }
  }
  throw new ToolError('Page checks are unavailable: no browser could be started', {
    code: TOOL_ERROR_CODE.ENOTSUPPORTED,
    hint: `Tell the user to run "npx playwright install chromium" or install Chrome. Tried: ${errors.join(' | ')}`,
  });
}
