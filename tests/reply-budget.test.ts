import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// How much room one reply gets: a thinking model on a hosted or GPU backend is not held to the CPU-only cap.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolveSessionBudget, MAX_REPLY_TOKENS } from '../src/agent/workspace/profile';
import { outputCapFromError, ModelGateway } from '../src/model/gateway';
import { ProviderError } from '../src/core/errors';
import { DEFAULTS } from '../src/core/config';
import { REASONING_MIN_PREDICT } from '../src/protocol';

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

  it('a thinking model on a local GPU gets it too', () => {
    assert.ok(budget({ thinking: true, cpuOnly: false }).maxTokens > REASONING_MIN_PREDICT);
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

  it('reads a model\'s reply limit from the provider\'s refusal', () => {
    const ollama = 'Ollama error 400: {"error":"max_tokens (80000) exceeds model\'s maximum output tokens (65536) for model nemotron-3-ultra (ref: 0786a35a-9767-43fd-827b-c6fc725a7535)"}';
    assert.equal(outputCapFromError(ollama, 80000), 65536);
    assert.equal(outputCapFromError('max_tokens is too large: 40000. This model supports at most 16384 completion tokens', 40000), 16384);
    assert.equal(outputCapFromError('max_new_tokens must be <= 4096', 8192), 4096);
    assert.equal(outputCapFromError('model not found', 80000), null);
    assert.equal(outputCapFromError('context length exceeded: 140000 tokens', 32768), null, 'a context error is not a reply limit');
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
