import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { TOOL_ERROR_CODE } from '../../protocol';
import { defineTool } from '../core/defineTool';
import { ok, fail, fromError } from '../core/tool-result';
import { withTimeoutSignal } from '../core/timeout-signal';
import { launchBrowser, type Browser } from './browser';
import { PAGE_CHECKS, type Finding } from './checks';
import { formatReport, viewportsFor, type ViewportFindings } from './report';

const NAVIGATION_TIMEOUT_MS = 20_000;
const SETTLE_TIMEOUT_MS = 3_000;
const TOTAL_TIMEOUT_MS = 90_000;

export default defineTool({
  name: 'check_page',
  profiles: ['core', 'planning'],
  category: 'web',
  // The page is served by something that can change without the workspace changing (a dev server that just started).
  changesOnItsOwn: true,
  activity: 'Checking a page in a browser',
  label: 'Check Page',
  brief: 'Open a web page in a headless browser at mobile, tablet, desktop and dark mode; report layout, accessibility and loading problems.',
  description:
    'Open a web page in a headless browser at mobile (375px), tablet (768px) and desktop (1280px) widths, and on desktop in dark mode, and report what is wrong: ' +
    'sideways scrolling and the elements causing it, accessibility problems (contrast, missing labels and alt text, small tap targets), ' +
    'script errors, and images, scripts or data that failed to load. Pass url for a running site (start a dev server first with ' +
    'exec_shell background: true), or path for a static .html file in the workspace. Use it after changing a web UI to check the change.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'http(s) URL of the page, e.g. http://localhost:5173/settings' },
      path: { type: 'string', pathArg: true, description: 'Workspace-relative path of a static .html file' },
      widths: { type: 'array', items: { type: 'number' }, description: 'Screen widths in px to check instead of 375, 768 and 1280' },
    },
    requiredOneOf: [['url'], ['path']],
  },
  preview(args) {
    return String(args?.url || args?.path || '');
  },
  async execute(args, ctx) {
    let target: string;
    let label: string;
    if (args.url) {
      let parsed: URL;
      try {
        parsed = new URL(String(args.url));
      } catch {
        return fail(`"${args.url}" is not a URL`, { code: TOOL_ERROR_CODE.EINVAL, hint: 'Pass a full http(s) URL, or path for a file in the workspace.' });
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return fail(`check_page opens http(s) URLs, not ${parsed.protocol}`, { code: TOOL_ERROR_CODE.EINVAL, hint: 'Pass path for a file in the workspace.' });
      }
      target = parsed.href;
      label = parsed.href;
    } else {
      const abs = String(args.path);
      label = ctx.ws.rel(abs);
      try {
        if (!(await fsp.stat(abs)).isFile()) return fail(`${label} is not a file`, { code: TOOL_ERROR_CODE.EISDIR });
      } catch (err) {
        return fromError(err);
      }
      target = pathToFileURL(abs).href;
    }

    const viewports = viewportsFor(args.widths);
    if (viewports.length === 0) {
      return fail('None of the widths can be checked', { code: TOOL_ERROR_CODE.EINVAL, hint: 'Widths are screen sizes in px between 200 and 3840.' });
    }

    const timer = withTimeoutSignal(ctx.signal, TOTAL_TIMEOUT_MS);
    let browser: Browser | undefined;
    const closeOnAbort = () => void browser?.close().catch(() => {});
    timer.signal.addEventListener('abort', closeOnAbort, { once: true });
    try {
      browser = await launchBrowser();
      const results: ViewportFindings[] = [];
      for (const viewport of viewports) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: viewport.colorScheme ?? 'light' });
        try {
          const page = await context.newPage();
          const collectors = await Promise.all(PAGE_CHECKS.map((check) => check.start(page)));
          try {
            await page.goto(target, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
          } catch (err) {
            const message = String((err as Error)?.message ?? err).split('\n')[0];
            return fail(`${label} could not be opened: ${message}`, {
              code: TOOL_ERROR_CODE.EUNKNOWN,
              hint: args.url ? 'Check that the server is running (subprocess_status) and the URL and port are right.' : undefined,
            });
          }
          await page.waitForLoadState('networkidle', { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
          const findings: Finding[] = [];
          for (const collect of collectors) findings.push(...(await collect()));
          results.push({ viewport, findings });
        } finally {
          await context.close().catch(() => {});
        }
      }
      const report = formatReport(label, results);
      return ok({
        kind: 'text',
        display: report.text,
        data: { target: label, widths: viewports.map((v) => v.width), findings: report.findings },
      });
    } catch (err) {
      if (timer.timedOut()) return fail(`Checking ${label} took longer than ${TOTAL_TIMEOUT_MS / 1000}s`, { code: TOOL_ERROR_CODE.ETIMEDOUT });
      return fromError(err);
    } finally {
      timer.signal.removeEventListener('abort', closeOnAbort);
      timer.dispose();
      await browser?.close().catch(() => {});
    }
  },
});
