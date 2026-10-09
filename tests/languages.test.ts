// The language table: what each project is detected as, and the rules every entry keeps.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { detectStacks } from '../src/env/tooling/detector';

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
