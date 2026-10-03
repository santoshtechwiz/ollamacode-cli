import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMcpServers, mcpReady, mcpServerStatus, closeMcpServers } from '../src/mcp/registry';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.cjs');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-mcp-home-'));
const previousHome = process.env.OLLAMACODE_HOME;
process.env.OLLAMACODE_HOME = home;
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
  mcpServers: [
    { name: 'fake', command: process.execPath, args: [SERVER, 'ok'] },
    // A typo in the command: this used to hang session start for good.
    { name: 'typo', command: 'no-such-mcp-binary-for-ocode-tests', args: [] },
  ],
}));

after(async () => {
  await closeMcpServers();
  if (previousHome === undefined) delete process.env.OLLAMACODE_HOME;
  else process.env.OLLAMACODE_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

it('servers connect in the background: the caller goes on at once, a broken one cannot hold anything up', async () => {
  const registered: string[] = [];
  const started = Date.now();
  startMcpServers((defs) => registered.push(...defs.map((d) => d.name)));
  assert.ok(Date.now() - started < 200, 'starting returns without waiting for any server');

  await mcpReady();
  assert.ok(Date.now() - started < 10_000, 'readiness settles even though one command does not exist');
  assert.deepEqual(registered, ['mcp__fake__echo']);
  assert.deepEqual(
    mcpServerStatus().map((s) => [s.name, s.connected]),
    [['fake', true], ['typo', false]],
  );
});
