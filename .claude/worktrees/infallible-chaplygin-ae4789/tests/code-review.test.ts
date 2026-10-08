import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, before, after } from 'node:test';

import { TOOL_META } from '../src/tool/index';
import { ToolExecutor } from '../src/tool/core/tool-runtime';
import { classifyTool } from '../src/tool/policy/mutation-policy';
import { analyzeSource, findDuplicateBlocks } from '../src/tool/review/_analysis';
import { detectTooling } from '../src/tool/review/_tooling';
import { analyzePolyglot } from '../src/tool/review/_polyglot';
import { TOOL_ERROR_CODE } from '../src/protocol';

const DUPLICATE = [
  'function normalize(items) {',
  '  const out = [];',
  '  for (const item of items) {',
  '    const key = String(item.id).trim();',
  '    if (!key) continue;',
  '    out.push({ key, value: item.value * 2 });',
  '  }',
  '  return out.sort((a, b) => a.key.localeCompare(b.key));',
  '}',
].join('\n');

const COMPLEX = `export function route(x: number, y: string) {
  if (x > 1 && y) return 1;
  if (x > 2 || y === 'a') return 2;
  for (let i = 0; i < x; i++) { if (i % 2) continue; }
  while (x-- > 0) { if (x === 5) break; }
  switch (y) { case 'a': return 3; case 'b': return 4; case 'c': return 5; default: break; }
  return x ? (y ? 6 : 7) : (y ?? 8);
}
`;

let root: string;

const write = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const gitRun = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'pipe' });

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-review-'));
  write('package.json', JSON.stringify({
    name: 'fixture',
    type: 'module',
    scripts: {
      lint: 'node -e "console.log(\'lint ok\')"',
      typecheck: 'node -e "console.log(\'types ok\')"',
      test: 'node -e "console.log(\'tests ok\')"',
    },
  }));
  write('src/a.ts', "import { b } from './b.ts';\nexport const a = () => b() + 1;\n");
  write('src/b.ts', "import { a } from './a.ts';\nexport function b() { return 1; }\nexport const useA = () => a();\n");
  write('src/types.ts', "import type { a } from './a.ts';\nexport type A = typeof a;\n");
  write('src/util.ts', [
    "import { readFileSync } from 'node:fs';",
    "import { a } from './a.ts';",
    '',
    'export function legacy() {',
    '  try { a(); } catch {}',
    '}',
    '',
    DUPLICATE,
    '',
  ].join('\n'));
  write('src/dup.ts', `${DUPLICATE}\nexport { normalize };\n`);
  write('src/main.ts', "import { legacy } from './util.ts';\nimport './dup.ts';\nlegacy();\n");
  gitRun('init', '-q');
  gitRun('add', '-A');
  gitRun('commit', '-q', '-m', 'base');
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

const review = (args: Record<string, unknown>) => new ToolExecutor({ root, state: { autoFixAuthorized: true } }).run('code_review', args);

describe('code_review analysis', () => {
  it('finds unused imports, empty catches, unawaited async calls, dead code and complexity', () => {
    const analysis = analyzeSource('x.ts', [
      "import { unused } from './u.ts';",
      'async function save() {}',
      'export async function run() {',
      '  save();',
      '  try { await save(); } catch {}',
      '  return 1;',
      '  console.log("never");',
      '}',
      COMPLEX,
    ].join('\n'));
    const cats = analysis.findings.map((f) => `${f.line}:${f.category}`);
    assert.ok(cats.includes('1:unused'), cats.join(' '));
    assert.ok(cats.includes('4:async'), cats.join(' '));
    assert.ok(cats.includes('5:error-handling'), cats.join(' '));
    assert.ok(cats.includes('7:dead-code'), cats.join(' '));
    assert.ok(analysis.findings.some((f) => f.category === 'complexity' && /route/.test(f.message)));
    assert.deepEqual(analysis.exports.map((e) => e.name), ['run', 'route']);
  });

  it('flags interpolated shell commands and eval as security findings', () => {
    const { findings } = analyzeSource('x.js', "import { exec } from 'node:child_process';\nexec(`rm ${process.argv[2]}`);\neval('1');\n");
    assert.equal(findings.filter((f) => f.category === 'security').length, 2);
  });

  it('detects a duplicated block across files, reported once', () => {
    const blocks = findDuplicateBlocks([{ file: 'one.js', text: DUPLICATE }, { file: 'two.js', text: `// x\n${DUPLICATE}` }]);
    assert.equal(blocks.length, 1);
    assert.deepEqual(blocks[0].locations.map((l) => l.file).sort(), ['one.js', 'two.js']);
  });
});

describe('code_review analysis in other languages', () => {
  const at = (findings: Array<{ line: number; category: string }>) => findings.map((f) => `${f.line}:${f.category}`);

  it('Python: unused imports, empty except, dead code, shell=True, eval, complexity', async () => {
    const a = await analyzePolyglot('a.py', [
      'import os',
      'from typing import List, Dict',
      'import subprocess',
      'def f(x: List[int]):',
      '    try:',
      "        subprocess.run('ls', shell=True)",
      '    except Exception:',
      '        pass',
      '    return 1',
      "    print('dead')",
      'def g(x):',
      '    return eval(x) if x and x > 1 else 0',
      '',
    ].join('\n'));
    assert.deepEqual(at(a!.findings), ['1:unused', '2:unused', '6:security', '7:error-handling', '10:dead-code', '12:security']);
    assert.match(a!.findings[1].message, /Dict/);
    assert.deepEqual(a!.functions.map((f) => `${f.name}:${f.complexity}`), ['f:2', 'g:3']);
  });

  it('Go, C#, Java: unused imports, empty catch (a commented one is intentional), unreachable code', async () => {
    const go = await analyzePolyglot('b.go', 'package m\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nfunc F(x int) int {\n\tif x > 1 {\n\t\treturn 1\n\t\tfmt.Println("x")\n\t}\n\treturn 0\n}\n');
    assert.deepEqual(at(go!.findings), ['5:unused', '11:dead-code']);

    const cs = await analyzePolyglot('c.cs', 'using System;\nclass K {\n  int F(int x) {\n    try { x++; } catch (Exception e) { }\n    try { x++; } catch (Exception e) { /* expected */ }\n    return x;\n    x++;\n  }\n}\n');
    assert.deepEqual(at(cs!.findings), ['4:error-handling', '7:dead-code']);

    const java = await analyzePolyglot('d.java', 'import java.util.List;\nimport java.util.Map;\nclass K { List<String> f() { try { } catch (Exception e) { } return null; } }\n');
    assert.deepEqual(at(java!.findings), ['2:unused', '3:error-handling']);
  });

  it('review_changes reviews a changed Python file and leaves an unchanged one alone', async () => {
    write('tools/old.py', 'def old_job():\n    try:\n        run()\n    except Exception:\n        pass\n');
    gitRun('add', '-A');
    gitRun('commit', '-q', '-m', 'py');
    write('tools/new.py', 'import os\n\ndef fresh():\n    return 1\n');
    try {
      const { result } = await review({});
      assert.equal(result.ok, true, result.error);
      const where = result.data.findings.map((f: any) => `${f.file}:${f.line}:${f.category}`);
      assert.ok(where.includes('tools/new.py:1:unused'), where.join(' '));
      assert.ok(!where.some((w: string) => w.startsWith('tools/old.py')), where.join(' '));
      assert.doesNotMatch(result.display ?? '', /no structural analysis/);
    } finally {
      fs.rmSync(path.join(root, 'tools/new.py'));
    }
  });
});

describe('code_review operations', () => {
  it('find_import_cycles reports the runtime cycle and ignores type-only imports', async () => {
    const { result } = await review({ operation: 'find_import_cycles' });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(result.data.cycles, [['src/a.ts', 'src/b.ts', 'src/a.ts']]);
  });

  it('find_unused reports the unused import and the export nothing imports', async () => {
    const { result } = await review({ operation: 'find_unused' });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.data.imports.some((i: any) => i.file === 'src/util.ts' && i.name === 'readFileSync'));
    assert.ok(result.data.exports.some((e: any) => e.file === 'src/b.ts' && e.name === 'useA'));
    assert.ok(!result.data.exports.some((e: any) => e.name === 'legacy'), 'imported exports are used');
  });

  it('find_duplicates, analyze_complexity, find_references and review_file', async () => {
    const dup = await review({ operation: 'find_duplicates' });
    assert.equal(dup.result.data.duplicates.length, 1);

    write('src/complex.ts', COMPLEX);
    const cx = await review({ operation: 'analyze_complexity', path: 'src' });
    assert.equal(cx.result.data.functions[0].name, 'route');
    fs.rmSync(path.join(root, 'src/complex.ts'));

    const refs = await review({ operation: 'find_references', symbol: 'legacy' });
    assert.deepEqual(refs.result.data.references.map((r: any) => `${r.file}:${r.line}`).sort(), ['src/main.ts:1', 'src/main.ts:3', 'src/util.ts:4']);

    const file = await review({ operation: 'review_file', path: 'src/util.ts' });
    assert.ok(file.result.data.findings.some((f: any) => f.category === 'error-handling' && f.line === 5));

    const sym = await review({ operation: 'review_symbol', symbol: 'b' });
    assert.equal(sym.result.data.definitions[0].file, 'src/b.ts');
  });

  it('review_changes reports only findings on changed lines and runs the project checks', async () => {
    // Pre-existing problem (util.ts empty catch) stays out; the new one is reported.
    write('src/b.ts', "import { a } from './a.ts';\nexport function b() { return 1; }\nexport const useA = () => a();\nexport function fresh() {\n  try { b(); } catch {}\n}\n");
    write('src/new.ts', "export const isolated = 1;\n");
    try {
      const { result } = await review({ checks: true, tests: true });
      assert.equal(result.ok, true, result.error ?? result.display);
      const files = result.data.files.map((f: any) => `${f.status}:${f.path}`);
      assert.deepEqual(files, ['modified:src/b.ts', 'untracked:src/new.ts']);
      const where = result.data.findings.map((f: any) => `${f.file}:${f.line}:${f.category}`);
      assert.ok(where.includes('src/b.ts:5:error-handling'), where.join(' '));
      assert.ok(where.includes('src/new.ts:1:unused'), where.join(' '));
      assert.ok(!where.some((w: string) => w.startsWith('src/util.ts')), 'untouched files are not reviewed');
      assert.deepEqual(result.data.checks.map((c: any) => `${c.kind}:${c.passed}`), ['lint:true', 'typecheck:true', 'test:true']);
      assert.equal(result.data.verification.passed, true);
      assert.match(result.display ?? '', /\[judge\]/);
    } finally {
      gitRun('checkout', '--', 'src/b.ts');
      fs.rmSync(path.join(root, 'src/new.ts'));
    }
  });

  it('review_changes narrows to path', async () => {
    write('src/a.ts', "import { b } from './b.ts';\nexport const a = () => b() + 3;\n");
    write('docs/note.js', 'export const n = 1;\n');
    try {
      const { result } = await review({ path: 'src' });
      assert.equal(result.ok, true, result.error);
      assert.equal(result.data.mode, 'diff');
      assert.deepEqual(result.data.files.map((f: any) => f.path), ['src/a.ts']);
    } finally {
      gitRun('checkout', '--', 'src/a.ts');
      fs.rmSync(path.join(root, 'docs'), { recursive: true });
    }
  });

  it('review_changes fails with EEXIT when a project check fails', async () => {
    write('src/a.ts', "import { b } from './b.ts';\nexport const a = () => b() + 2;\n");
    try {
      const { result } = await review({ tests: true, test_command: 'node -e "console.error(\'1 failing\'); process.exit(1)"' });
      assert.equal(result.ok, false);
      assert.equal(result.code, TOOL_ERROR_CODE.EEXIT);
      assert.equal(result.data.verification.passed, false);
    } finally {
      gitRun('checkout', '--', 'src/a.ts');
    }
  });

  it('runs checks in the subproject that holds the change, and skips a check whose tool is not installed', async () => {
    write('svc/package.json', JSON.stringify({
      name: 'svc',
      scripts: { lint: 'node -e "console.log(\'svc lint ok\')"', typecheck: 'ocode-test-no-such-tool-xyz --check' },
    }));
    gitRun('add', '-A');
    gitRun('commit', '-q', '-m', 'svc');
    write('svc/index.js', 'export const s = 1;\n');
    try {
      const { result } = await review({ checks: true });
      assert.equal(result.ok, true, result.error ?? result.display);
      assert.deepEqual(
        result.data.checks.map((c: any) => `${c.project}:${c.kind}:${c.passed ? 'pass' : c.unavailable ? 'skip' : 'fail'}`),
        ['svc:lint:pass', 'svc:typecheck:skip'],
      );
      assert.match(result.display ?? '', /SKIP typecheck in svc: .*\n\s+its tool is not installed/);
    } finally {
      fs.rmSync(path.join(root, 'svc/index.js'));
    }
  });

  it('detects existing tooling without installing anything', async () => {
    const tooling = await detectTooling(root);
    assert.deepEqual(tooling.checks.map((c) => c.command), ['npm run lint', 'npm run typecheck', 'npm test']);
    assert.deepEqual(tooling.analyzers, { knip: false, madge: false });
  });

  it('is read-only until it runs project code', () => {
    const meta = { code_review: TOOL_META.code_review };
    assert.equal(classifyTool('code_review', { operation: 'review_changes' }, { meta }), 'read-only');
    assert.equal(classifyTool('code_review', { checks: true }, { meta }), 'mutating');
    assert.equal(classifyTool('code_review', { tests: true }, { meta }), 'mutating');
    assert.equal(classifyTool('code_review', { operation: 'review_file', checks: true }, { meta }), 'mutating');
    assert.equal(classifyTool('code_review', { operation: 'review_file', test_command: 'npm test' }, { meta }), 'mutating');
  });

  it('asks to run checks only on the operations that run them', () => {
    const meta = { code_review: TOOL_META.code_review };
    assert.equal(classifyTool('code_review', { operation: 'find_duplicates', checks: true }, { meta }), 'read-only');
    assert.equal(TOOL_META.code_review.preview!({ operation: 'find_duplicates', checks: true }), 'find_duplicates');
    assert.equal(TOOL_META.code_review.preview!({ operation: 'review_file', path: 'a.cs', checks: true }), 'review_file a.cs (+lint/typecheck/build)');
  });

  it('review_file runs the checks it was approved for, in the file\'s project', async () => {
    const { result } = await review({ operation: 'review_file', path: 'src/util.ts', checks: true });
    assert.equal(result.ok, true, result.error ?? result.display);
    assert.deepEqual(result.data.checks.map((c: any) => `${c.project}:${c.kind}:${c.passed}`), ['.:lint:true', '.:typecheck:true']);
    assert.match(result.display ?? '', /\[checks\]\n\s+PASS lint: npm run lint/);
    assert.equal(result.data.verification.passed, true);

    const failing = await review({ operation: 'review_file', path: 'src/util.ts', test_command: 'node -e "process.exit(2)"' });
    assert.equal(failing.result.ok, false);
    assert.equal(failing.result.code, TOOL_ERROR_CODE.EEXIT);
  });
});

describe('code_review checks for compiled languages', () => {
  let dir: string;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-review-dotnet-'));
    fs.mkdirSync(path.join(dir, 'Demo'));
    fs.writeFileSync(path.join(dir, 'Demo', 'Demo.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
    fs.writeFileSync(path.join(dir, 'Demo', 'Hello.cs'), 'class Hello { static void Main() { try { } catch (System.Exception) { } } }\n');
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('runs the build for .NET, named build, not typecheck', async () => {
    const tooling = await detectTooling(path.join(dir, 'Demo'));
    assert.deepEqual(tooling.checks.filter((c) => c.kind === 'build').map((c) => c.command), ['dotnet build']);
    assert.equal(tooling.checks.some((c) => c.kind === 'typecheck'), false);
  });

  it('review_file on a .cs file runs dotnet build in its project (or skips it when dotnet is not installed)', async () => {
    const { result } = await new ToolExecutor({ root: dir, state: { autoFixAuthorized: true } }).run('code_review', { operation: 'review_file', path: 'Demo/Hello.cs', checks: true });
    assert.ok(result.data.findings.some((f: any) => f.category === 'error-handling'), 'the static review still runs');
    const build = result.data.checks.find((c: any) => c.kind === 'build');
    assert.equal(build.project, 'Demo');
    assert.equal(build.command, 'dotnet build');
    // Whether the build passes depends on the installed SDK, not on ocode: it either ran (exit code) or was skipped as not installed.
    assert.ok(build.unavailable || typeof build.exitCode === 'number', JSON.stringify(build));
  });
});

describe('code_review without git', () => {
  let plain: string;
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(plain, rel)), { recursive: true });
    fs.writeFileSync(path.join(plain, rel), text);
  };

  before(() => {
    plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-review-nogit-'));
    put('TodoApp/package.json', JSON.stringify({
      name: 'todo',
      scripts: { lint: 'node -e "console.log(\'todo lint ok\')"', test: 'node -e "console.log(\'todo tests ok\')"' },
    }));
    put('TodoApp/src/store.js', 'export function save(list) {\n  try { localStorage.setItem("todos", JSON.stringify(list)); } catch {}\n}\n');
    put('TodoApp/src/app.js', "import { save } from './store.js';\nsave([]);\n");
    put('Other/bad.js', 'export function x() {\n  try { y(); } catch {}\n}\n');
  });

  after(() => fs.rmSync(plain, { recursive: true, force: true }));

  const reviewIn = (args: Record<string, unknown>) => new ToolExecutor({ root: plain, state: { autoFixAuthorized: true } }).run('code_review', args);

  it('reviews every file under path whole and runs that project\'s checks', async () => {
    const { result } = await reviewIn({ path: 'TodoApp', checks: true, tests: true });
    assert.equal(result.ok, true, result.error ?? result.display);
    assert.equal(result.data.mode, 'all-files');
    assert.deepEqual(result.data.files.map((f: any) => f.path), ['TodoApp/src/app.js', 'TodoApp/src/store.js']);
    const where = result.data.findings.map((f: any) => `${f.file}:${f.line}:${f.category}`);
    assert.ok(where.includes('TodoApp/src/store.js:2:error-handling'), where.join(' '));
    assert.ok(!where.some((w: string) => w.startsWith('Other/')), 'files outside path are not reviewed');
    assert.deepEqual(result.data.checks.map((c: any) => `${c.project}:${c.kind}:${c.passed}`), ['TodoApp:lint:true', 'TodoApp:test:true']);
    assert.match(result.display ?? '', /^not a git repository: reviewed all 2 file\(s\) under TodoApp whole/);
  });

  it('refuses a base ref, which needs git, by saying to leave it out — never to run git init', async () => {
    const { result } = await reviewIn({ base: 'main' });
    assert.equal(result.ok, false);
    assert.equal(result.code, TOOL_ERROR_CODE.EINVAL);
    assert.match(result.hint ?? '', /Leave base out/);
    assert.doesNotMatch(`${result.error} ${result.hint} ${result.display ?? ''}`, /git init/);
  });

  it('refuses a base that names no commit in a repository with none yet, and reviews without one', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-review-nocommit-'));
    try {
      fs.writeFileSync(path.join(repo, 'a.js'), 'export function x() {\n  try { y(); } catch {}\n}\n');
      execFileSync('git', ['init', '-q'], { cwd: repo });
      const run = (args: Record<string, unknown>) => new ToolExecutor({ root: repo, state: {} }).run('code_review', args);
      const refused = (await run({ base: 'HEAD' })).result;
      assert.equal(refused.code, TOOL_ERROR_CODE.EINVAL);
      assert.match(refused.error ?? '', /no commits yet/);
      const reviewed = (await run({})).result;
      assert.equal(reviewed.ok, true, reviewed.error);
      assert.ok(reviewed.data.findings.some((f: any) => f.file === 'a.js'));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
