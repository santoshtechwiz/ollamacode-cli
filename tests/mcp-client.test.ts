import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { McpClient, quoteForCmd } from '../src/mcp/client';

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
    await assert.rejects(client.callTool('echo', {}, 10_000), /stopped \(exit code 3\); its last output:\nfatal: GITHUB_TOKEN is not set/);
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

describe('listing tools', () => {
  it('follows every page of the listing', async () => {
    const client = fake('big', 'paged');
    try {
      await client.connect(5000);
      assert.deepEqual((await client.listTools()).map((t) => t.name), ['echo', 'second']);
    } finally {
      await client.close();
    }
  });
});

describe('when a server says no', () => {
  it('an error reply keeps its JSON-RPC code and says what it means', async () => {
    const client = fake('strict', 'invalid');
    try {
      await client.connect(5000);
      await assert.rejects(client.callTool('echo', {}, 5000), (err: any) =>
        err.code === -32602 && /repo is required \(invalid arguments, code -32602\)/.test(err.message));
    } finally {
      await client.close();
    }
  });

  it('a line far past any reply is dropped without holding it, and the reply after it still reads', async () => {
    const previous = McpClient.MAX_LINE_CHARS;
    McpClient.MAX_LINE_CHARS = 1024;
    const client = fake('noisy', 'flood', '4096');
    let held = 0;
    const read = client._onData.bind(client);
    client._onData = (chunk: string) => {
      read(chunk);
      held = Math.max(held, client.buffer.length);
    };
    try {
      await client.connect(5000);
      assert.equal((await client.callTool('echo', {}, 5000)).text, 'echoed');
      assert.ok(held <= 1024, `held ${held} characters`);
    } finally {
      McpClient.MAX_LINE_CHARS = previous;
      await client.close();
    }
  });
});

describe('the handshake', () => {
  it('tells the server the version of ocode that is running', async () => {
    const seen = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-mcp-')), 'hello.json');
    const client = fake('greeter', 'hello', seen);
    try {
      await client.connect(5000);
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
      assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')).clientInfo, { name: 'ollamacode', version: pkg.version });
    } finally {
      await client.close();
      fs.rmSync(path.dirname(seen), { recursive: true, force: true });
    }
  });
});

describe('arguments through a Windows shim', () => {
  it('quotes what cmd.exe would split or run, and leaves plain words alone', () => {
    assert.equal(quoteForCmd('@playwright/mcp@latest'), '@playwright/mcp@latest');
    assert.equal(quoteForCmd('C:\\Program Files\\data'), '"C:\\Program Files\\data"');
    assert.equal(quoteForCmd('a&b'), '"a&b"');
    assert.equal(quoteForCmd('--root=C:\\dir\\'), '"--root=C:\\dir\\\\"');
    assert.equal(quoteForCmd('say "hi"'), '"say \\"hi\\""');
    assert.equal(quoteForCmd(''), '""');
  });
});
