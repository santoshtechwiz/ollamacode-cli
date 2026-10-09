// check_page opens a page at several widths and reports what is wrong; the same problem at several widths is one line.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';
import { launchBrowser } from '../src/tool/browser/browser';
import { formatReport, DEFAULT_VIEWPORTS } from '../src/tool/browser/report';

const browserAvailable = await launchBrowser().then(
  async (b) => (await b.close(), true),
  () => false,
);

function workspace(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-page-'));
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
  return root;
}

async function check(root: string, args: Record<string, unknown>): Promise<any> {
  return (await createExecutor({ root, state: createWorkspaceState(root) }).run('check_page', args)).result;
}

const BAD = `<!doctype html><html lang="en"><head><title>Broken</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body><main><h1>Hi</h1><div class="hero" style="width:900px">wide</div>
<p style="color:#bbb;background:#fff">faint text</p>
<input type="text"><img src="missing.png"><img src="gone.png" alt=""><img src="lost.png" alt="">
<script>throw new Error('boom')</script></main></body></html>`;

describe('check_page report', () => {
  it('merges one problem seen at several widths into one line', () => {
    const [mobile, tablet, desktop] = DEFAULT_VIEWPORTS;
    const same = { check: 'scripts', severity: 'error' as const, message: 'Uncaught script error: boom' };
    const { text, findings } = formatReport('index.html', [
      { viewport: mobile, findings: [same, { check: 'layout', severity: 'error', message: 'wide', where: ['div.hero (900px)'] }] },
      { viewport: tablet, findings: [same, { check: 'layout', severity: 'error', message: 'wide', where: ['div.hero (900px)'] }] },
      { viewport: desktop, findings: [same, { check: 'accessibility', severity: 'warning', message: 'minor thing' }] },
    ]);
    assert.equal(findings.length, 3);
    assert.match(text, /^index\.html: 2 errors, 1 warning \(checked at mobile 375px, tablet 768px, desktop 1280px\)\./);
    assert.match(text, /✗ \[scripts\] Uncaught script error: boom — everywhere checked/);
    assert.match(text, /✗ \[layout\] wide — mobile, tablet\n {4}div\.hero \(900px\)/);
    assert.ok(text.trimEnd().endsWith('! [accessibility] minor thing — desktop'), 'warnings come after errors');
  });
});

describe('check_page in a browser', { skip: browserAvailable ? false : 'no browser available' }, () => {

  it('reports sideways scrolling, script errors, missing files and accessibility problems', async () => {
    const root = workspace({ 'index.html': BAD });
    try {
      const r = await check(root, { path: 'index.html' });
      assert.equal(r.ok, true, r.error);
      assert.match(r.display, /\[layout\] The page is wider than the screen, so it scrolls sideways; .* — mobile, tablet\n {4}div\.hero \(\d+px\)/);
      assert.match(r.display, /\[scripts\] Uncaught script error: boom — everywhere checked/);
      assert.doesNotMatch(r.display, /Failed to load resource/, 'a failed load is reported once, by the requests check');
      assert.match(r.display, /\[requests\] Resources failed to load .* — everywhere checked\n {4}file:.*gone\.png.*\n {4}file:.*lost\.png.*\n {4}file:.*missing\.png/);
      assert.match(r.display, /\[accessibility\] .*\(color-contrast, serious\)/);
      assert.match(r.display, /\[accessibility\] .*\(label, critical\)/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks dark mode too: a scaffold\'s dark background under text styled for light', async () => {
    const page = `<!doctype html><html lang="en"><head><title>Dark</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{background:#fff;color:#111} @media (prefers-color-scheme: dark){body{background:#0a0a0a}}</style></head>
<body><main><h1>Studio</h1><p>Portraits and landscapes.</p></main></body></html>`;
    const root = workspace({ 'index.html': page });
    try {
      const r = await check(root, { path: 'index.html' });
      assert.equal(r.ok, true, r.error);
      assert.match(r.display, /checked at mobile 375px, tablet 768px, desktop 1280px, desktop dark 1280px/);
      assert.match(r.display, /\[accessibility\] .*\(color-contrast, serious\) — desktop dark\n/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a URL that is not http(s)', async () => {
    const r = await check(os.tmpdir(), { url: 'ftp://example.com/' });
    assert.equal(r.ok, false);
    assert.match(r.error, /opens http\(s\) URLs, not ftp:/);
  });
});
