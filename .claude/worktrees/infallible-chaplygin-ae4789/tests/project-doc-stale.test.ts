import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { detectStacks } from '../src/env/tooling/detector';
import { projectDocStale, projectFingerprint, updateMemory } from '../src/context/memory';

function project(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-docstale-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body);
  return root;
}

// What /init leaves behind: the doc, and the fingerprint of the project it described.
async function initDone(root: string) {
  fs.writeFileSync(path.join(root, 'OLLAMACODE.md'), '# Project\n');
  const fingerprint = projectFingerprint(await detectStacks(root), root);
  updateMemory(root, (m: any) => { m.project.initFingerprint = fingerprint; });
}

describe('OLLAMACODE.md staleness', () => {
  it('is fresh right after /init, and stays fresh when only code changes', async () => {
    const root = project({ 'package.json': '{"name":"x","scripts":{"test":"node --test"}}', 'index.js': 'console.log(1)\n' });
    await initDone(root);
    assert.equal(projectDocStale(root, await detectStacks(root)), false);
    fs.writeFileSync(path.join(root, 'index.js'), 'console.log(2)\n');
    assert.equal(projectDocStale(root, await detectStacks(root)), false);
  });

  it('is stale once the project changes shape: a new stack or manifest', async () => {
    const root = project({ 'package.json': '{"name":"x","scripts":{"test":"node --test"}}', 'index.js': 'console.log(1)\n' });
    await initDone(root);
    fs.writeFileSync(path.join(root, 'go.mod'), 'module example.com/x\n\ngo 1.22\n');
    assert.equal(projectDocStale(root, await detectStacks(root)), true);
  });

  it('never calls a doc stale that /init did not record, or that does not exist', async () => {
    const root = project({ 'package.json': '{"name":"x"}' });
    assert.equal(projectDocStale(root, await detectStacks(root)), false);
    fs.writeFileSync(path.join(root, 'OLLAMACODE.md'), '# Written by hand\n');
    assert.equal(projectDocStale(root, await detectStacks(root)), false);
  });
});
