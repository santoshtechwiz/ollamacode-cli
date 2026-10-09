// The language table: what each project is detected as, and the rules every entry keeps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { detectStacks } from '../src/env/tooling/detector';
import { OUTPUT_PARSERS } from '../src/env/parsers';
import { eslintFiles, frameworksOf } from '../src/env/frameworks';

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-lang-'));
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(root, rel), text);
  return root;
}

describe('a Node project', () => {
  it('is TypeScript when it has a tsconfig.json or its scripts run tsc, not for a typescript dependency alone', async () => {
    const cases: Array<[Record<string, string>, boolean]> = [
      [{ 'package.json': JSON.stringify({ devDependencies: { typescript: '5' } }) }, false],
      [{ 'package.json': '{}', 'tsconfig.json': '{}' }, true],
      [{ 'package.json': JSON.stringify({ scripts: { build: 'tsc -p .' } }) }, true],
    ];
    for (const [files, ts] of cases) {
      const root = project(files);
      try {
        const [stack] = await detectStacks(root);
        assert.equal(stack.id, 'node');
        assert.equal(stack.typescript, ts, JSON.stringify(files));
        assert.equal(stack.label, ts ? 'TypeScript' : 'Node.js');
        assert.deepEqual(stack.check, ts ? ['npx', 'tsc', '--noEmit'] : undefined);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });
});

describe('a Node project\'s own tools', () => {
  it('runs tsc and eslint from its node_modules with node, not through npx, when they are installed', async () => {
    const root = project({ 'package.json': JSON.stringify({ devDependencies: { eslint: '9', typescript: '5' } }), 'tsconfig.json': '{}' });
    try {
      for (const [name, bin] of [['typescript', { tsc: 'bin/tsc' }], ['eslint', { eslint: './bin/eslint.js' }]] as const) {
        const dir = path.join(root, 'node_modules', name);
        fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, bin }));
        fs.writeFileSync(path.join(dir, Object.values(bin)[0]), '');
      }
      const [stack] = await detectStacks(root);
      assert.deepEqual(stack.check, ['node', 'node_modules/typescript/bin/tsc', '--noEmit']);
      assert.deepEqual(stack.fileScoped?.lint?.argv, ['node', 'node_modules/eslint/bin/eslint.js']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the OUTPUT_PARSERS registry', () => {

  // One real-looking output per parser and a diagnostic it must find: a new parser is one entry here.
  const CASES: Array<{ parser: string; output: string; expect: Record<string, unknown> }> = [
    { parser: 'tsc', output: "src/a.ts(3,5): error TS2304: Cannot find name 'foo'.", expect: { file: 'src/a.ts', line: 3, column: 5, code: 'TS2304', kind: 'missing', symbol: 'foo' } },
    { parser: 'node-test', output: "not ok 1 - adds numbers\n  ---\n  location: '/p/test/a.test.js:4:3'", expect: { file: '/p/test/a.test.js', line: 4, severity: 'failure', message: 'adds numbers' } },
    { parser: 'jest', output: '  ● sum › adds\n\n    expect(received).toBe(expected)\n\n      at Object.<anonymous> (src/sum.test.js:5:17)', expect: { file: 'src/sum.test.js', line: 5, message: 'sum › adds' } },
    { parser: 'vitest', output: ' FAIL  src/sum.test.ts > sum > adds\n', expect: { file: 'src/sum.test.ts', message: 'sum > adds' } },
    { parser: 'mocha', output: '  1) sum\n       adds:\n     AssertionError [ERR_ASSERTION]: Expected 3\n      at Context.<anonymous> (test/sum.js:7:12)', expect: { file: 'test/sum.js', line: 7, severity: 'failure' } },
    { parser: 'node-runtime', output: '/app/index.js:12\nfoo();\n^\n\nReferenceError: foo is not defined\n    at Object.<anonymous> (/app/index.js:12:1)', expect: { code: 'ReferenceError', kind: 'missing', symbol: 'foo' } },
    { parser: 'pytest', output: 'FAILED tests/test_a.py::test_add - assert 1 == 2', expect: { file: 'tests/test_a.py', severity: 'failure', message: 'test_add: assert 1 == 2' } },
    { parser: 'dotnet', output: "Program.cs(5,9): error CS0103: The name 'foo' does not exist in the current context [/p/App.csproj]", expect: { file: 'Program.cs', line: 5, code: 'CS0103', kind: 'missing', symbol: 'foo', project: '/p/App.csproj' } },
    { parser: 'cargo', output: 'error[E0425]: cannot find value `x` in this scope\n --> src/main.rs:2:5', expect: { file: 'src/main.rs', line: 2, column: 5, code: 'E0425' } },
    { parser: 'go', output: './main.go:5:2: undefined: foo', expect: { file: 'main.go', line: 5, column: 2, message: 'undefined: foo' } },
    { parser: 'terraform', output: 'Error: Unsupported argument\n\n  on main.tf line 3, in resource "x" "y":', expect: { file: 'main.tf', line: 3, severity: 'error' } },
    { parser: 'git-conflicts', output: 'CONFLICT (content): Merge conflict in src/a.ts', expect: { file: 'src/a.ts', severity: 'error' } },
  ];

  for (const c of CASES) {
    it(`${c.parser} reads its output`, () => {
      const parser = OUTPUT_PARSERS.find((p) => p.id === c.parser)!;
      const found = parser.parse(c.output);
      const match = found.find((d: any) => Object.entries(c.expect).every(([key, value]) => d[key] === value));
      assert.ok(match, `${c.parser} found ${JSON.stringify(found)}`);
    });
  }
});

describe('frameworks', () => {
  // Front-end frameworks are rows in one table: detected from package.json, they name the stack and widen what ESLint reads.
  const labels = (deps: Record<string, string>, dev: Record<string, string> = {}) => frameworksOf({ dependencies: deps, devDependencies: dev }).map((f) => f.label);

  describe('frameworksOf', () => {
    it('names the most specific framework, not the one it is built on', () => {
      assert.deepEqual(labels({ next: '16', react: '19' }), ['Next.js']);
      assert.deepEqual(labels({ nuxt: '3', vue: '3' }), ['Nuxt']);
      assert.deepEqual(labels({}, { '@sveltejs/kit': '2', svelte: '5' }), ['SvelteKit']);
      assert.deepEqual(labels({ react: '19' }), ['React']);
      assert.deepEqual(labels({ '@angular/core': '20' }), ['Angular']);
      assert.deepEqual(labels({ express: '5' }), []);
    });
  });

  describe('eslintFiles', () => {
    it('lints scripts, and a framework\'s own files only when its ESLint plugin is installed', () => {
      assert.equal(eslintFiles({ dependencies: { vue: '3' } }), undefined, 'no ESLint, nothing to run');
      const plain = eslintFiles({ dependencies: { vue: '3' }, devDependencies: { eslint: '9' } })!;
      assert.deepEqual(plain.argv, ['npx', 'eslint']);
      assert.equal(plain.extensions.includes('.vue'), false);
      const withPlugins = eslintFiles({ devDependencies: { eslint: '9', 'eslint-plugin-vue': '9', 'angular-eslint': '20' } })!;
      assert.ok(withPlugins.extensions.includes('.vue') && withPlugins.extensions.includes('.html') && withPlugins.extensions.includes('.tsx'));
    });
  });
});
