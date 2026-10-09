#!/usr/bin/env node
// `node scripts/check-page.mjs <file.html | url>` runs ocode's check_page from the shell, in the current folder, and
// prints its report. Exit 0: no errors; 1: errors found; 2: the page could not be checked. The eval scores web
// scenarios with it, so a page is judged by the same checks the agent sees.
import { register } from 'tsx/esm/api';

register();
await import('../src/tool/index.ts');
const { createExecutor } = await import('../src/tool/execution/executor.ts');
const { createWorkspaceState } = await import('../src/context/workspace-state.ts');

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/check-page.mjs <file.html | url>');
  process.exit(2);
}
const root = process.cwd();
const args = /^https?:\/\//i.test(target) ? { url: target } : { path: target };
const { result } = await createExecutor({ root, state: createWorkspaceState(root) }).run('check_page', args);
if (!result.ok) {
  console.error(`${result.error}${result.hint ? `\n${result.hint}` : ''}`);
  process.exit(2);
}
console.log(result.display);
process.exit(result.data.findings.some((f) => f.severity === 'error') ? 1 : 0);
