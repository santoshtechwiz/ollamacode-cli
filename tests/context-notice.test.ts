// The context fills up: older history is capped, the person is told before and when it is trimmed, and /compact trims now.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildModelRequest, DEFAULT_HISTORY_TOKENS } from '../src/context/builder';
import { ContextStore } from '../src/context/store';
import { runCompact } from '../src/cli/commands/cmds/compact';
import { ROLE } from '../src/protocol';

/** A conversation of n finished exchanges, each about `words` words long. */
function conversation(n: number, words = 400): ContextStore {
  const messages: any[] = [];
  const text = (tag: string) => Array.from({ length: words }, (_, i) => `${tag}${i}`).join(' ');
  for (let i = 0; i < n; i++) messages.push({ role: ROLE.USER, content: `question ${i} ${text('q')}` }, { role: ROLE.ASSISTANT, content: `answer ${i} ${text('a')}` });
  messages.push({ role: ROLE.USER, content: 'the new question' });
  return new ContextStore({ messages });
}

async function request(store: ContextStore) {
  await buildModelRequest({ store, systemMessages: [{ role: ROLE.SYSTEM, content: 'You are ocode.' }], modelLimits: { contextWindow: 200_000, maxOutputTokens: 80_000 } } as any);
  return store.lastBudget!;
}

describe('context filling up', () => {
  it('older history is capped at the default even with a 200k window', async () => {
    const budget = await request(conversation(200));
    assert.ok(budget.historyTokens <= DEFAULT_HISTORY_TOKENS + 500, `history ${budget.historyTokens}`);
    assert.ok(budget.dropped > 0);
  });

  it('/compact summary keeps a model-written summary of what it removed', async () => {
    const store = conversation(40);
    const asked: any[] = [];
    const provider = {
      id: 'test', label: 'Test', detect: async () => true, ensureAuth: async () => {}, listModels: async () => [],
      async streamChat({ messages }: any) {
        asked.push(messages);
        return { content: '- built the parser in src/parse.js\n- tests still failing on dates', toolCalls: [], finishReason: 'stop' };
      },
    };
    const written: string[] = [];
    await runCompact({
      history: store, write: (t: string) => written.push(t), persist: () => {},
      session: { provider, model: 'm' }, cfg: { agent: { maxRetries: 0, idleTimeoutMs: 10_000, firstTokenTimeoutMs: 10_000 } }, workspace: {},
    }, 'summary');
    assert.equal(asked.length, 1);
    assert.match(asked[0][1].content, /question 39/, 'the older conversation was sent, newest kept when long');
    assert.ok(asked[0][1].content.length <= 60_000);
    assert.match(String(store.preservedSummary), /^Summary of the earlier conversation:\n- built the parser/);
    assert.match(written.join(''), /A summary of what was removed is kept/);
  });

  it('/compact keeps the latest request and cuts the rest down', async () => {
    const store = conversation(40);
    const before = store.tokenCount;
    const written: string[] = [];
    let saved = 0;
    await runCompact({ history: store, write: (t: string) => written.push(t), persist: () => { saved += 1; } });
    assert.ok(store.tokenCount < before / 4, `${before} → ${store.tokenCount}`);
    assert.equal(store.messages.at(-1)?.content, 'the new question');
    assert.match(String(store.preservedSummary), /Earlier conversation trimmed/);
    assert.equal(saved, 1);
    assert.match(written.join(''), /compacted/);
  });
});
