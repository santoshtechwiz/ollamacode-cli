import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig } from '../src/core/config';

/** Load a config.json with these contents from a private home. */
function loaded(file: Record<string, unknown>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-cfg-'));
  const before = process.env.OLLAMACODE_HOME;
  process.env.OLLAMACODE_HOME = home;
  try {
    fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(file));
    return loadConfig();
  } finally {
    if (before === undefined) delete process.env.OLLAMACODE_HOME;
    else process.env.OLLAMACODE_HOME = before;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('a config file from an older version', () => {
  it('does not keep the old 24-step limit as if it were chosen', () => {
    assert.equal(loaded({ agent: { maxIterations: 24 } }).agent.maxIterations, 100);
    assert.equal(loaded({ configVersion: 2, agent: { maxIterations: 24 } }).agent.maxIterations, 100);
  });

  it('keeps a step limit that was chosen', () => {
    assert.equal(loaded({ configVersion: 3, agent: { maxIterations: 24 } }).agent.maxIterations, 24);
    assert.equal(loaded({ configVersion: 2, agent: { maxIterations: 40 } }).agent.maxIterations, 40);
  });
});
