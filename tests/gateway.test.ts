import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ModelGateway } from '../src/model/gateway';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveSessionBudget, MAX_REPLY_TOKENS } from '../src/agent/workspace/profile';
import { ProviderError } from '../src/core/errors';
import { DEFAULTS } from '../src/core/config';
import { REASONING_MIN_PREDICT } from '../src/protocol';

describe('idle-timeout', () => {
  /** Streams one thought, then goes quiet; when aborted it hands back what it had, as the Ollama stream reader does. */
  function stallingProvider(calls: { n: number }, { recoverOnRetry = false } = {}) {
    return {
      id: 'fake', label: 'Fake',
      detect: async () => true, ensureAuth: async () => true, listModels: async () => [],
      async streamChat({ signal, onReasoning }: any) {
        calls.n += 1;
        if (recoverOnRetry && calls.n > 1) return { content: 'Here is the next step.', toolCalls: [], finishReason: 'stop' };
        onReasoning?.('Thinking about the ride service…');
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        return { content: '', toolCalls: [], reasoning: 'Thinking about the ride service…', finishReason: 'aborted' };
      },
    };
  }

  describe('a reply the idle timer cut off', () => {
    it('is a timeout, not an empty answer', async () => {
      const calls = { n: 0 };
      const gateway = new ModelGateway({ provider: stallingProvider(calls), model: 'm', config: { maxRetries: 0, idleTimeoutMs: 50, firstTokenTimeoutMs: 50, maxTokens: 256 } });
      await assert.rejects(gateway.stream({ messages: [{ role: 'user', content: 'continue' }] }), /No response for/);
    });

    it('is retried, and a retry that answers is the reply', async () => {
      const calls = { n: 0 };
      const gateway = new ModelGateway({ provider: stallingProvider(calls, { recoverOnRetry: true }), model: 'm', config: { maxRetries: 2, idleTimeoutMs: 50, firstTokenTimeoutMs: 50, maxTokens: 256 } });
      const called = await gateway.stream({ messages: [{ role: 'user', content: 'continue' }] });
      assert.equal(called.result.content, 'Here is the next step.');
      assert.equal(calls.n, 2);
    });
  });
});

describe('reply-budget', () => {
  // How much room one reply gets: a thinking model on a hosted or GPU backend is not held to the CPU-only cap.
  const budget = (opts: { thinking: boolean; remote?: boolean; cpuOnly?: boolean }) => {
    const ws: any = { thinkingEnabled: opts.thinking };
    resolveSessionBudget(ws, { declared: 200_000, remote: opts.remote, cpuOnly: opts.cpuOnly });
    return ws;
  };

  describe('reply budget', () => {
    it('a thinking model on a hosted backend gets the same room as any other', () => {
      const ws = budget({ thinking: true, remote: true });
      assert.equal(ws.maxTokens, Math.min(MAX_REPLY_TOKENS, Math.floor(ws.contextWindow * 0.4)));
      assert.ok(ws.maxTokens > REASONING_MIN_PREDICT);
    });

    it('on a CPU-only machine a thinking model keeps the small cap, and others the default', () => {
      assert.equal(budget({ thinking: true, cpuOnly: true }).maxTokens, REASONING_MIN_PREDICT);
      assert.equal(budget({ thinking: false, cpuOnly: true }).maxTokens, DEFAULTS.agent.maxTokens);
    });

    it('a limit the person chose is kept', () => {
      const ws: any = { thinkingEnabled: true, maxTokensChosen: true, maxTokens: 4096 };
      resolveSessionBudget(ws, { declared: 200_000, remote: true });
      assert.equal(ws.maxTokens, 4096);
    });

    it('a refused reply size is learned and the same request asked again, once', async () => {
      process.env.OLLAMACODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-home-'));
      const asked: number[] = [];
      const provider = {
        id: 'ollama-cloud',
        label: 'Ollama Cloud',
        detect: async () => true,
        ensureAuth: async () => {},
        listModels: async () => [],
        async streamChat({ sampling }: any) {
          asked.push(sampling.maxTokens);
          if (sampling.maxTokens > 65536) {
            throw new ProviderError(`Ollama error 400: {"error":"max_tokens (${sampling.maxTokens}) exceeds model's maximum output tokens (65536) for model nemotron-3-ultra"}`, { status: 400 });
          }
          return { content: 'done', toolCalls: [], finishReason: 'stop' };
        },
      };
      const gateway = new ModelGateway({ provider, model: 'nemotron-learn', config: { maxRetries: 0, idleTimeoutMs: 10_000, firstTokenTimeoutMs: 10_000, maxTokens: 80000 } });
      assert.equal((await gateway.stream({ messages: [{ role: 'user', content: 'hi' }] })).result.content, 'done');
      assert.deepEqual(asked, [80000, 65536]);
      await gateway.stream({ messages: [{ role: 'user', content: 'again' }] });
      assert.deepEqual(asked, [80000, 65536, 65536], 'the next request starts at the learned limit');
      const saved = JSON.parse(fs.readFileSync(path.join(process.env.OLLAMACODE_HOME!, 'model-limits.json'), 'utf8'));
      assert.deepEqual(saved['ollama-cloud/nemotron-learn'], { maxOutputTokens: 65536 }, 'kept for the next run');
    });
  });
});

describe('openrouter', () => {
  it('lists only tool-taking models, reads a streamed tool call and its usage, and names a bad key', async () => {
    const http = await import('node:http');
    const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + ': keep-alive\n\ndata: [DONE]\n\n';
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer sk-or-good') { res.writeHead(401); return res.end('{"error":{"message":"No auth"}}'); }
      if (req.url === '/api/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [
          { id: 'qwen/qwen3-coder', context_length: 262144, supported_parameters: ['tools', 'reasoning'] },
          { id: 'some/chat-only', context_length: 8192, supported_parameters: ['temperature'] },
        ] }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse([
        { choices: [{ delta: { reasoning: 'look first' } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        // OpenRouter sends the token counts after the finish chunk.
        { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 30 } },
      ]));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const saved = { base: process.env.OPENROUTER_BASE_URL, key: process.env.OPENROUTER_API_KEY };
    process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}/api/v1`;
    process.env.OPENROUTER_API_KEY = 'sk-or-good';
    const { getProvider } = await import('../src/model/providers/registry');
    const provider: any = getProvider('openrouter');
    try {
      provider.clearCache();
      assert.deepEqual(await provider.listModels(), [{ name: 'qwen/qwen3-coder' }]);
      assert.equal((await provider.modelInfo('qwen/qwen3-coder')).contextLength, 262144);
      const reply = await provider.streamChat({ model: 'qwen/qwen3-coder', messages: [{ role: 'user', content: 'hi' }], tools: [{}] });
      assert.deepEqual(reply.toolCalls.map((c: any) => [c.function.name, c.function.arguments]), [['read_file', { path: 'a.txt' }]]);
      assert.equal(reply.reasoning, 'look first');
      assert.equal(reply.usage?.promptTokens, 1200, 'usage after the finish chunk is read');
      process.env.OPENROUTER_API_KEY = 'sk-or-bad';
      await assert.rejects(provider.streamChat({ model: 'qwen/qwen3-coder', messages: [] }), /Invalid OpenRouter key/);
    } finally {
      provider.clearCache();
      for (const [k, v] of [['OPENROUTER_BASE_URL', saved.base], ['OPENROUTER_API_KEY', saved.key]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      server.close();
    }
  });
});
