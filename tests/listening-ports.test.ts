// Where a background job really listens, read from the system: a dev server that had printed only "> next dev" left
// a model to make up "port 3000 was busy, so it is on 3001".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import '../src/tool/index.ts';
import { ToolExecutor } from '../src/tool/core/tool-runtime';
import { createWorkspaceState } from '../src/context/workspace-state';
import { describeListening, listeningPorts, parseLsof, parseNetstat, parseProcessTable, parseSs, processTree } from '../src/tool/process/analysis/listening-ports';

describe('reading the system\'s listeners', () => {
  it('reads Windows netstat, Linux ss and lsof output', () => {
    assert.deepEqual(parseNetstat([
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       14640',
      '  TCP    [::]:3001              [::]:0                 LISTENING       14640',
      '  TCP    127.0.0.1:52011        127.0.0.1:3001         ESTABLISHED     9000',
      '  UDP    0.0.0.0:5353           *:*                                    1200',
    ].join('\r\n')), [{ pid: 14640, port: 3001 }, { pid: 14640, port: 3001 }]);
    assert.deepEqual(parseSs('LISTEN 0 511 *:3000 *:* users:(("next-server",pid=4242,fd=21))\nESTAB 0 0 1.2.3.4:5 6.7.8.9:10'), [{ pid: 4242, port: 3000 }]);
    assert.deepEqual(parseLsof('p4242\nf21\nn*:3000\nn[::1]:3001\np99\nn127.0.0.1:5432'), [{ pid: 4242, port: 3000 }, { pid: 4242, port: 3001 }, { pid: 99, port: 5432 }]);
  });

  it('counts every process under the job, not only the one it started', () => {
    const table = parseProcessTable('  10 1\n  20 10\n  30 20\n  40 1\n');
    assert.deepEqual([...processTree(10, table)].sort(), [10, 20, 30]);
  });

  it('says plainly when it is not listening yet, and nothing when it could not look', () => {
    assert.match(String(describeListening([])), /^Not listening on any port yet/);
    assert.equal(describeListening([3001]), 'Listening on http://localhost:3001');
    assert.equal(describeListening(null), null);
  });
});

describe('a background server', () => {
  it('reports the port it really listens on, at start and on status', async (t) => {
    if ((await listeningPorts(process.pid)) === null) return t.skip('this system cannot list listeners');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-ports-'));
    fs.writeFileSync(path.join(root, 'server.js'), "require('http').createServer((q, s) => s.end('ok')).listen(0, () => console.log('started'));\n");
    const state: any = createWorkspaceState(root);
    const ex = new ToolExecutor({ root, state: Object.assign(state, { autoFixAuthorized: true }) });
    try {
      const started: any = (await ex.run('exec_shell', { command: 'node server.js', background: true })).result;
      assert.equal(started.ok, true, started.error);
      assert.match(started.display, /Listening on http:\/\/localhost:\d+/);
      const port = started.data.ports[0];
      assert.match(started.display, new RegExp(`at http://localhost:${port}`), 'the head names the real address');
      const status: any = (await ex.run('subprocess_status', { id: started.data.id })).result;
      assert.match(status.display, new RegExp(`Listening on http://localhost:${port}`));
    } finally {
      for (const sub of state.subprocesses.values()) sub.process.kill();
      state.reset?.();
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });
});
