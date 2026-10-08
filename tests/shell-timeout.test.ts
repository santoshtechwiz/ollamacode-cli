import assert from 'node:assert/strict';
import os from 'node:os';
import { describe, it } from 'node:test';

import { validateShellRequest } from '../src/tool/process/execution/request';

const timeoutOf = async (args: Record<string, unknown>, canAsk: boolean) => {
  const v: any = await validateShellRequest({ command: 'npm install', ...args }, { cwd: os.tmpdir(), root: os.tmpdir(), canAsk });
  return v.request.timeoutMs;
};

describe('how long a shell command may run', () => {
  it('in a chat, with no limit given, the person decides at the two-minute check-in', async () => {
    assert.equal(await timeoutOf({}, true), 0);
  });
  it('with nobody to ask, it keeps the two-minute default', async () => {
    assert.equal(await timeoutOf({}, false), 120_000);
  });
  it('a limit the model set is kept either way', async () => {
    assert.equal(await timeoutOf({ timeout_ms: 300_000 }, true), 300_000);
    assert.equal(await timeoutOf({ timeout_ms: 300_000 }, false), 300_000);
  });
});
