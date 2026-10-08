import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ModelGateway } from '../src/model/gateway';

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
