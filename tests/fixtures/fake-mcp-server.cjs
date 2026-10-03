// A minimal stdio MCP server for tests. argv[2] picks how it misbehaves:
//   ok          answers everything
//   die         exits on every tools/call, saying why on stderr first
//   invalid     answers tools/call with a JSON-RPC invalid-arguments error
//   hello       records the initialize params in argv[3]
//   flood       answers tools/call with argv[3] characters and no line end, then ends that line and replies
//   die-once    exits on the first tools/call (marker file in argv[3]), answers after a restart
//   image       answers tools/call with a large image
//   paged       lists its tools over two pages
//   slow        never answers tools/call; records a cancel notification in argv[3]
//   asks        before answering tools/list, sends its own ping with the same id, and records the reply in argv[3]
const fs = require('node:fs');
const mode = process.argv[2] || 'ok';
const marker = process.argv[3];
let buf = '';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf('\n'); i !== -1; i = buf.indexOf('\n')) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'notifications/cancelled') {
      if (marker) fs.writeFileSync(marker, JSON.stringify(msg.params));
      continue;
    }
    if (!msg.method) {
      // A reply to a request this server made.
      if (marker) fs.writeFileSync(marker, JSON.stringify(msg));
      continue;
    }
    if (msg.method === 'initialize') {
      if (mode === 'hello' && marker) fs.writeFileSync(marker, JSON.stringify(msg.params));
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });
    } else if (msg.method === 'tools/list') {
      if (mode === 'asks') send({ jsonrpc: '2.0', id: msg.id, method: 'ping' });
      if (mode === 'paged') {
        const second = msg.params && msg.params.cursor === 'page-2';
        send({ jsonrpc: '2.0', id: msg.id, result: second ? { tools: [{ name: 'second' }] } : { tools: [{ name: 'echo' }], nextCursor: 'page-2' } });
        continue;
      }
      send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object', properties: {} } }] } });
    } else if (msg.method === 'tools/call') {
      if (mode === 'die') {
        process.stderr.write('fatal: GITHUB_TOKEN is not set\n', () => process.exit(3));
        continue;
      }
      if (mode === 'invalid') {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'repo is required' } });
        continue;
      }
      if (mode === 'flood') {
        process.stdout.write('x'.repeat(Number(marker) || 4096));
        const id = msg.id;
        setTimeout(() => {
          process.stdout.write('\n');
          send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'echoed' }] } });
        }, 100);
        continue;
      }
      if (mode === 'slow') continue;
      if (mode === 'die-once' && marker && !fs.existsSync(marker)) {
        fs.writeFileSync(marker, 'died');
        process.exit(3);
      }
      if (mode === 'image') send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'image', mimeType: 'image/png', data: 'A'.repeat(200000) }] } });
      else send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echoed' }] } });
    }
  }
});
