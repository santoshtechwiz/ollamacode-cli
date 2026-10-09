import { createRequire } from 'node:module';
import fs from 'node:fs';
import type { BrowserPage } from './browser';

// What check_page looks for on a page. A check is data: one more entry in PAGE_CHECKS is one more kind of problem
// reported, and no other code changes. Each check starts before the page loads (to catch what happens while it loads)
// and returns a function that collects its findings once the page has settled.

export interface Finding {
  /** The check that found it, e.g. "layout". */
  check: string;
  severity: 'error' | 'warning';
  message: string;
  /** The elements or URLs it is about, already described for a reader. */
  where?: string[];
}

export interface PageCheck {
  id: string;
  start(page: BrowserPage): Promise<() => Promise<Finding[]>> | (() => Promise<Finding[]>);
}

/** Elements or URLs named per finding; the rest are counted. */
export const MAX_WHERE = 5;

function capped(items: string[]): string[] {
  const unique = [...new Set(items)];
  return unique.length <= MAX_WHERE ? unique : [...unique.slice(0, MAX_WHERE), `…and ${unique.length - MAX_WHERE} more`];
}

// Uncaught errors only: console.error is often a library's development warning, and the browser logs failed loads
// there too, which the requests check already reports.
const scriptErrors: PageCheck = {
  id: 'scripts',
  start(page) {
    const seen: string[] = [];
    page.on('pageerror', (err) => seen.push(String(err?.message ?? err)));
    return async () =>
      [...new Set(seen)].map((text) => ({ check: 'scripts', severity: 'error' as const, message: `Uncaught script error: ${text.split('\n')[0].slice(0, 300)}` }));
  },
};

const failedRequests: PageCheck = {
  id: 'requests',
  start(page) {
    // Sorted when reported: loads finish in a different order at each width, and the same failures must read the same.
    const failed: string[] = [];
    page.on('requestfailed', (req) => failed.push(`${req.url()} (${req.failure()?.errorText ?? 'failed'})`));
    page.on('response', (res) => {
      if (res.status() >= 400) failed.push(`${res.url()} (HTTP ${res.status()})`);
    });
    return async () =>
      failed.length === 0 ? [] : [{ check: 'requests', severity: 'error' as const, message: 'Resources failed to load (images, scripts, styles or data)', where: capped([...failed].sort()) }];
  },
};

/** Runs in the page: how wide it is against the screen, and the elements that stick out past the right edge. */
const MEASURE_OVERFLOW = `(() => {
  const screen = document.documentElement.clientWidth;
  const width = document.documentElement.scrollWidth;
  const describe = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 2) : [];
    if (cls.length) s += '.' + cls.join('.');
    return s;
  };
  const wide = [];
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.right > screen + 1 && !(el.parentElement && el.parentElement.getBoundingClientRect().right > screen + 1)) {
      wide.push(describe(el) + ' (' + Math.round(r.right) + 'px)');
    }
  }
  return { screen, width, wide };
})()`;

const horizontalOverflow: PageCheck = {
  id: 'layout',
  start(page) {
    return async () => {
      const { screen, width, wide } = await page.evaluate<{ screen: number; width: number; wide: string[] }>(MEASURE_OVERFLOW);
      if (width <= screen + 1) return [];
      // No sizes in the message, so the same overflow at several widths reads as one problem.
      return [{
        check: 'layout',
        severity: 'error',
        message: 'The page is wider than the screen, so it scrolls sideways; these elements end past the right edge',
        where: capped(wide),
      }];
    };
  },
};

/** axe-core's rules for WCAG 2.2 A and AA: contrast, labels, alt text, names, target size, landmarks. */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

let axeSource: string | null | undefined;
function loadAxeSource(): string | null {
  if (axeSource !== undefined) return axeSource;
  try {
    axeSource = fs.readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
  } catch {
    axeSource = null;
  }
  return axeSource;
}

const accessibility: PageCheck = {
  id: 'accessibility',
  start(page) {
    return async () => {
      const source = loadAxeSource();
      if (!source) {
        return [{ check: 'accessibility', severity: 'warning', message: 'Accessibility was not checked: the optional axe-core package is not installed' }];
      }
      await page.addScriptTag({ content: source });
      const violations = await page.evaluate<Array<{ id: string; impact: string | null; help: string; nodes: Array<{ target: unknown[] }> }>>(
        (tags: string[]) => (globalThis as any).axe.run(document, { runOnly: { type: 'tag', values: tags } }).then((r: any) => r.violations),
        AXE_TAGS,
      );
      return violations.map((v) => ({
        check: 'accessibility',
        severity: v.impact === 'critical' || v.impact === 'serious' ? ('error' as const) : ('warning' as const),
        message: `${v.help} (${v.id}, ${v.impact ?? 'minor'})`,
        where: capped(v.nodes.map((n) => n.target.map(String).join(' '))),
      }));
    };
  },
};

export const PAGE_CHECKS: readonly PageCheck[] = Object.freeze([scriptErrors, failedRequests, horizontalOverflow, accessibility]);
