// End to end: a real `ocode chat` process, driven by a scripted model, does a repository task with
// run_script → a targeted edit → code_review, which runs the fixture's own oxlint, tsc and node tests.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, before, after } from 'node:test';

const repo = fileURLToPath(new URL('..', import.meta.url));
const TASK = 'One module that imports ToolExecutor passes the wrong name to run(); find the importers and fix it.';
const FINAL = 'Fixed src/b.ts: it called run with "B"; it now passes "b". Review, lint, typecheck and tests pass.';

// The model's side of the conversation. Each step is taken once the previous tool result is in.
const PROVIDER = `
import fs from 'node:fs';
const FINAL = ${JSON.stringify(FINAL)};
const SCRIPT = [
  "import fs from 'node:fs/promises';",
  "const hits = [];",
  "async function walk(dir) {",
  "  for (const e of await fs.readdir(dir, { withFileTypes: true })) {",
  "    const p = dir + '/' + e.name;",
  "    if (e.isDirectory()) await walk(p);",
  "    else if (p.endsWith('.ts')) {",
  "      const text = await fs.readFile(p, 'utf8');",
  "      if (/import.*ToolExecutor/.test(text)) hits.push(p + ': ' + (text.match(/run\\\\([^)]*\\\\)/g) ?? []).join(' '));",
  "    }",
  "  }",
  "}",
  "await walk('src');",
  "console.log(hits.sort().join('\\\\n'));",
].join('\\n');
const STEPS = [
  { name: 'run_script', arguments: { code: SCRIPT } },
  { name: 'read_file', arguments: { path: 'src/b.ts' } },
  { name: 'edit_file', arguments: { path: 'src/b.ts', search: "run('B')", replace: "run('b')" } },
  { name: 'code_review', arguments: { operation: 'review_changes', checks: true, tests: true } },
];
export default {
  id: 'scripted',
  label: 'Scripted',
  async detect() { return { available: true, detail: 'scripted test model' }; },
  async ensureAuth() { return true; },
  async listModels() { return [{ name: 'scripted' }]; },
  async streamChat({ messages, tools }) {
    // A fresh session holds only this task; ocode re-sends the request after the tool exchange, so count over all of it.
    const step = messages.filter((m) => m.role === 'assistant' && m.tool_calls?.length).length;
    const lastTool = [...messages].reverse().find((m) => m.role === 'tool');
    fs.appendFileSync(process.env.SCRIPTED_LOG, JSON.stringify({
      step,
      offered: (tools ?? []).map((t) => t.function?.name ?? t.name),
      lastTool: lastTool ? String(lastTool.content) : null,
    }) + '\\n');
    if (step < STEPS.length) {
      const call = STEPS[step];
      return { content: '', toolCalls: [{ id: 'call_' + step, type: 'function', function: call }], finishReason: 'tool_calls' };
    }
    return { content: FINAL, toolCalls: [], finishReason: 'stop' };
  },
};
`;

let work: string;
let project: string;
let home: string;
let logFile: string;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
  fs.writeFileSync(path.join(project, rel), text);
};
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8' });

before(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-accept-'));
  project = path.join(work, 'project');
  home = path.join(work, 'home');
  logFile = path.join(work, 'model.log');
  fs.mkdirSync(path.join(home, 'providers'), { recursive: true });
  fs.writeFileSync(path.join(home, 'providers', 'scripted.mjs'), PROVIDER);

  write('package.json', JSON.stringify({
    name: 'fixture',
    private: true,
    type: 'module',
    scripts: {
      lint: 'oxlint src',
      typecheck: 'tsc --noEmit -p .',
      test: 'node --import tsx --test tests/run.test.ts',
    },
  }, null, 2));
  write('tsconfig.json', JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', allowImportingTsExtensions: true, types: ['node'] },
    include: ['src', 'tests'],
  }));
  write('.gitignore', 'node_modules\n');
  write('src/executor.ts', 'export class ToolExecutor {\n  run(name: string): string {\n    return `ran ${name}`;\n  }\n}\n');
  write('src/a.ts', "import { ToolExecutor } from './executor.ts';\n\nexport function runA(): string {\n  return new ToolExecutor().run('a');\n}\n");
  write('src/b.ts', "import { ToolExecutor } from './executor.ts';\n\nexport function runB(): string {\n  return new ToolExecutor().run('B');\n}\n");
  write('src/c.ts', "export const c = 'no executor here';\n");
  write('tests/run.test.ts', "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { runA } from '../src/a.ts';\nimport { runB } from '../src/b.ts';\n\ntest('each module passes its own name', () => {\n  assert.equal(runA(), 'ran a');\n  assert.equal(runB(), 'ran b');\n});\n");
  // The project's tooling is ocode's own installed oxlint, typescript and tsx; nothing is installed.
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(project, 'node_modules'), 'junction');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
});

after(() => { if (!process.env.KEEP_ACCEPT) fs.rmSync(work, { recursive: true, force: true }); });

describe('ocode chat acceptance', () => {
  it('repository task → run_script → targeted edit → code_review with lint/typecheck/tests → final answer', () => {
    // A private OS temp dir for the CLI, so other suites' scripts running in parallel cannot blur the cleanup check.
    const tmp = path.join(work, 'tmp');
    fs.mkdirSync(tmp);

    const run = spawnSync(process.execPath, [path.join(repo, 'bin', 'cli.js'), 'chat', '--provider', 'scripted', '--model', 'scripted', '--yes'], {
      cwd: project,
      input: `${TASK}\n`,
      encoding: 'utf8',
      env: { ...process.env, OLLAMACODE_HOME: home, SCRIPTED_LOG: logFile, NO_COLOR: '1', CI: '1', TMPDIR: tmp, TEMP: tmp, TMP: tmp },
      timeout: 240_000,
    });
    const out = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 0, out);

    const log = fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const after = (step: number) => log.find((e) => e.step === step)?.lastTool ?? '';

    // A work request puts run_script and code_review on the wire up front.
    for (const name of ['run_script', 'code_review']) assert.ok(log[0].offered.includes(name), `offered: ${log[0].offered.join(',')}`);

    // 1. run_script found exactly the two importers and the bad call.
    assert.match(after(1), /src\/a\.ts: run\('a'\)/);
    assert.match(after(1), /src\/b\.ts: run\('B'\)/);
    assert.doesNotMatch(after(1), /c\.ts/);

    // 2-3. The targeted edit landed, and nothing else changed.
    assert.match(fs.readFileSync(path.join(project, 'src/b.ts'), 'utf8'), /run\('b'\)/);
    const status = git('status', '--porcelain', '--untracked-files=all')
      .split('\n').filter(Boolean)
      .filter((l) => !/\s\.(?:agent|ollamacode)\//.test(l));
    assert.deepEqual(status, [' M src/b.ts'], 'only the intended file changed; no scripts were left in the project');

    // 4. code_review reviewed the change and ran the project's own lint, typecheck and tests.
    const review = after(4);
    assert.match(review, /modified\s+src\/b\.ts/);
    assert.match(review, /PASS lint: npm run lint/);
    assert.match(review, /PASS typecheck: npm run typecheck/);
    assert.match(review, /PASS test: npm test/);

    // 5. The final answer reached the user.
    assert.ok(out.includes(FINAL), out);

    // The ephemeral script was written to the OS temp directory and removed from there too.
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('ocode-script-')), []);
  });
});
