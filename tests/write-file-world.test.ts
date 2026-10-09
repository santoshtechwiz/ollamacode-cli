import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import writeFile from '../src/tool/filesystem/write-file.tool';

async function ctxFor(root: string) {
  const changes: Array<{ op: string; rel: string; type: string }> = [];
  const ctx = {
    root,
    ws: { rel: (abs: string) => path.relative(root, abs).split(path.sep).join('/') },
    state: {
      note(op: string, rel: string, type: string) {
        changes.push({ op, rel, type });
      },
    },
  } as any;
  return { ctx, changes };
}

test('rewriting identical content does not advance the world', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-'));
  try {
    const file = path.join(root, 'same.txt');
    await fs.writeFile(file, 'stable\n', 'utf8');
    const { ctx, changes } = await ctxFor(root);

    const result = await writeFile.execute({ path: file, content: 'stable\n' } as any, ctx);

    assert.equal(result.ok, true);
    // The bytes on disk are unchanged, so the workspace did not move. Recording a change here
    // would advance the world and make this same write look like fresh work next time.
    assert.equal(changes.length, 0, 'a no-op write must not record a change');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('rewriting different content advances the world', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-'));
  try {
    const file = path.join(root, 'changed.txt');
    await fs.writeFile(file, 'before\n', 'utf8');
    const { ctx, changes } = await ctxFor(root);

    const result = await writeFile.execute({ path: file, content: 'after\n' } as any, ctx);

    assert.equal(result.ok, true);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].op, 'overwrite');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
