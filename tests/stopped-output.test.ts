import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import execShell from '../src/tool/process/exec-shell.tool';
import { renderToolResult } from '../src/agent/router/render';

describe('a command stopped before it exited', () => {
  it('still gives the model what it printed: a test run that failed and then never exited', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-stopped-'));
    // Prints its failures, then keeps an open handle, as a Jest run with an unclosed server or database does.
    fs.writeFileSync(path.join(dir, 'hang.js'), "console.log('Tests:       3 failed, 3 total');\nconsole.log('Jest did not exit one second after the test run has completed.');\nsetInterval(() => {}, 1000);\n");
    const stop = new AbortController();
    try {
      setTimeout(() => stop.abort(), 1500);
      const result: any = await execShell.execute({ command: 'node hang.js' }, { cwd: dir, root: dir, signal: stop.signal } as any);
      assert.equal(result.ok, false);
      const seen = renderToolResult(result, 'exec_shell');
      assert.match(seen, /stopped before it exited/);
      assert.match(seen, /Tests: +3 failed, 3 total/);
      assert.match(seen, /Jest did not exit/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
