// The language table: what each project is detected as, and the rules every entry keeps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { detectStacks } from '../src/env/tooling/detector';
import { LANGUAGES, VERBS } from '../src/env/languages';
import { TOOLS } from '../src/env/toolchains';
import { OUTPUT_PARSERS } from '../src/env/parsers';

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

describe('the LANGUAGES table', () => {
  it('every entry has a unique id, a label, a runtime, a way to be found, and only known verbs', () => {
    const ids = LANGUAGES.map((l) => l.id);
    assert.equal(new Set(ids).size, ids.length, 'unique ids');
    for (const lang of LANGUAGES) {
      assert.ok(lang.label, `${lang.id} has a label`);
      assert.ok(lang.runtimes.length > 0, `${lang.id} has a runtime`);
      assert.ok(lang.markers?.length || lang.markerPattern || lang.extensions?.length || lang.detect, `${lang.id} can be detected`);
      for (const verb of Object.keys(lang.commands ?? {})) assert.ok((VERBS as readonly string[]).includes(verb), `${lang.id}: ${verb} is a verb`);
      for (const [verb, scoped] of Object.entries(lang.fileScoped ?? {})) {
        assert.ok((VERBS as readonly string[]).includes(verb), `${lang.id}: ${verb} is a verb`);
        const made = scoped!('cmd');
        assert.ok(made.argv.length > 0 && made.extensions.every((e) => e.startsWith('.')), `${lang.id}: ${verb} names a command and extensions`);
      }
    }
  });
});

describe('the OUTPUT_PARSERS registry', () => {
  it('has unique ids, and each names stacks that exist', () => {
    const ids = OUTPUT_PARSERS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length);
    const stacks = new Set([...LANGUAGES, ...TOOLS].map((p) => p.id));
    for (const parser of OUTPUT_PARSERS) for (const s of parser.stacks) assert.ok(stacks.has(s), `${parser.id}: stack ${s}`);
  });

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

  it('every parser has a case', () => {
    const covered = new Set(CASES.map((c) => c.parser));
    const missing = OUTPUT_PARSERS.map((p) => p.id).filter((id) => !covered.has(id));
    assert.deepEqual(missing, []);
  });

  for (const c of CASES) {
    it(`${c.parser} reads its output`, () => {
      const parser = OUTPUT_PARSERS.find((p) => p.id === c.parser)!;
      const found = parser.parse(c.output);
      const match = found.find((d: any) => Object.entries(c.expect).every(([key, value]) => d[key] === value));
      assert.ok(match, `${c.parser} found ${JSON.stringify(found)}`);
    });
  }
});
