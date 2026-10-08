// A foreground command that turns out to be serving is handed to the background, still running, with its output so far.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import '../src/tool/index';
import { createExecutor } from '../src/tool/execution/executor';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentState } from '../src/agent/state';
import { applyApprovalPolicy } from '../src/tool/policy/permission-policy';
import { renderToolResult } from '../src/agent/router/render';

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-serve-'));
  fs.writeFileSync(path.join(cwd, 'index.js'),
    "const http=require('http');const s=http.createServer((q,r)=>{console.log('GET '+q.url);r.end('ok')});" +
    "s.listen(0,()=>console.log('Server listening on http://localhost:'+s.address().port));");
  const state: any = createWorkspaceState(cwd, { sessionId: `s${Date.now()}` });
  state.permissions = createAgentState().permissions;
  applyApprovalPolicy(state, { yes: true });
  return { cwd, ex: createExecutor({ root: cwd, state }) };
}

describe('a foreground command that is serving', () => {
  it('comes back in seconds, keeps running in the background, and its later output is still captured', async () => {
    const w = workspace();
    let id = '';
    try {
      const started = Date.now();
      const r: any = (await w.ex.run('exec_shell', { command: 'node index.js' })).result;
      assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
      assert.equal(r.ok, true, r.error);
      assert.equal(r.data.background, true);
      id = r.data.id;
      assert.match(r.display, /is serving at http:\/\/localhost:\d+ .* carries on in the background/);
      assert.match(r.display, /Output so far:\nServer listening on/);
      assert.equal(await (await fetch(`${r.data.url}/hello`)).text(), 'ok', 'still serving after the handover');
      await new Promise((res) => setTimeout(res, 300));
      const status: any = (await w.ex.run('subprocess_status', { id })).result;
      assert.match(String(status.display), /GET \/hello/, 'output printed after the handover is captured');
    } finally {
      if (id) await w.ex.run('stop_subprocess', { id });
      fs.rmSync(w.cwd, { recursive: true, force: true });
    }
  });

  it('a test run that prints an address and goes quiet is waited for, and its failure is its result', async () => {
    const w = workspace();
    try {
      fs.writeFileSync(path.join(w.cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node slow.test.js' } }));
      fs.writeFileSync(path.join(w.cwd, 'slow.test.js'),
        "console.log('app listening on http://localhost:3000');setTimeout(()=>{console.log('1 failing');process.exit(1)},2500);");
      const r: any = (await w.ex.run('exec_shell', { command: 'npm test' })).result;
      assert.ok(!r.data?.background, 'not handed to the background');
      assert.equal(r.ok, false);
      assert.match(String(r.display ?? r.error), /1 failing/);
    } finally {
      fs.rmSync(w.cwd, { recursive: true, force: true });
    }
  });

  it('a command that only mentions an address and exits runs as usual', async () => {
    const w = workspace();
    try {
      const r: any = (await w.ex.run('exec_shell', { command: `node -e "console.log('docs at http://localhost:1234')"` })).result;
      assert.equal(r.ok, true);
      assert.ok(!r.data?.background);
    } finally {
      fs.rmSync(w.cwd, { recursive: true, force: true });
    }
  });

  it('a "server" that exits at once is reported as exiting on its own, with where to look', async () => {
    const w = workspace();
    try {
      fs.writeFileSync(path.join(w.cwd, 'server.js'), "module.exports = require('http').createServer();");
      const r: any = (await w.ex.run('start_subprocess', { command: 'node server.js' })).result;
      assert.equal(r.ok, true);
      const seen = renderToolResult(r, 'start_subprocess');
      assert.match(seen, /it exited on its own: it is not listening\. Read its code for why/);
      assert.match(seen, /background jobs do keep running/);
    } finally {
      fs.rmSync(w.cwd, { recursive: true, force: true });
    }
  });
});
