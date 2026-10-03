import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../src/tool/index';
import { gatherContext } from '../src/context/auto-context';

test('key files go into auto-context as their own text, without line numbers', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-autoctx-'));
  try {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{\n  "name": "demo",\n  "scripts": { "test": "node --test" }\n}\n');
    const block = await gatherContext(cwd, { projectDoc: null });
    assert.match(block, /package\.json:\n\{\n {2}"name": "demo",/);
    assert.doesNotMatch(block, /^\s+\d+\t/m, 'no line-number gutter');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
