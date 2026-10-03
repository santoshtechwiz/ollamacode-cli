import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { McpClient } from '../src/mcp/client';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-mcp-server.cjs');
const fake = (name: string, ...args: string[]) => new McpClient({ name, command: process.execPath, args: [SERVER, ...args] } as any);
const elapsed = async (fn: () => Promise<unknown>) => {
  const t = Date.now();
  await fn().catch(() => {});
  return Date.now() - t;
};

describe('an MCP server that cannot be started, or stops', () => {
  it('a command that does not exist fails to connect, and closing it returns at once', async () => {
    const client = new McpClient({ name: 'missing', command: 'no-such-mcp-binary-for-ocode-tests', args: [] } as any);
    await assert.rejects(client.connect(3000), /ENOENT|not found|cannot find/i);
    assert.ok((await elapsed(() => client.close())) < 1000, 'close() used to wait forever for an exit that never comes');
  });

  it('once the server stopped, a call fails at once and says why, instead of waiting out the timeout', async () => {
    const client = fake('dying', 'die');
    await client.connect(5000);
    await assert.rejects(client.callTool('echo', {}, 10_000), /stopped \(exit code 3\)/);
    let message = '';
    const took = await elapsed(async () => {
      try {
        await client.callTool('echo', {}, 10_000);
      } catch (err) {
        message = (err as Error).message;
      }
    });
    assert.match(message, /stopped/);
    assert.ok(took < 1000, `failed after ${took}ms`);
  });

  it('a stopped server can be started again, a bounded number of times', async () => {
    const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-mcp-')), 'died');
    const client = fake('flaky', 'die-once', marker);
    try {
      await client.connect(5000);
      await assert.rejects(client.callTool('echo', {}, 5000), /stopped/);
      assert.equal(await client.restart(), true);
      assert.equal((await client.callTool('echo', {}, 5000)).text, 'echoed');
      client.restarts = McpClient.MAX_RESTARTS;
      assert.equal(await client.restart(), false, 'no more restarts once they are used up');
    } finally {
      await client.close();
      fs.rmSync(path.dirname(marker), { recursive: true, force: true });
    }
  });
});

describe('requests the server makes', () => {
  it('a server request is answered, and never mistaken for the reply to ours that shares its id', async () => {
    const reply = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-mcp-')), 'reply.json');
    const client = fake('asker', 'asks', reply);
    try {
      await client.connect(5000);
      const tools = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name), ['echo'], 'the real reply, not the ping that came first with the same id');
      for (let i = 0; i < 50 && !fs.existsSync(reply); i++) await new Promise((r) => setTimeout(r, 20));
      assert.deepEqual(JSON.parse(fs.readFileSync(reply, 'utf8')).result, {}, 'the ping was answered');
    } finally {
      await client.close();
      fs.rmSync(path.dirname(reply), { recursive: true, force: true });
    }
  });
});

describe('what a tool returns', () => {
  it('an image is named with its size, not handed to the model as base64', async () => {
    const client = fake('camera', 'image');
    try {
      await client.connect(5000);
      const { text } = await client.callTool('echo', {}, 5000);
      assert.equal(text, '[image image/png, 146 KB — not shown as text]');
    } finally {
      await client.close();
    }
  });
});

describe('stopping a call', () => {
  it('a cancelled call stops at once, and the server is told which request to drop', async () => {
    const note = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-mcp-')), 'cancel.json');
    const client = fake('slowpoke', 'slow', note);
    try {
      await client.connect(5000);
      const controller = new AbortController();
      const call = client.callTool('echo', {}, 30_000, controller.signal);
      setTimeout(() => controller.abort(), 50);
      const took = await elapsed(() => assert.rejects(call, (err: any) => err.code === 'ECANCELLED'));
      assert.ok(took < 2000, `stopped after ${took}ms`);
      for (let i = 0; i < 50 && !fs.existsSync(note); i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(JSON.parse(fs.readFileSync(note, 'utf8')).requestId, 2, 'the tools/call request, the one after initialize');
    } finally {
      await client.close();
      fs.rmSync(path.dirname(note), { recursive: true, force: true });
    }
  });
});
