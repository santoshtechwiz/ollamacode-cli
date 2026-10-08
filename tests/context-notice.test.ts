// The context fills up: older history is capped, the person is told before and when it is trimmed, and /compact trims now.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildModelRequest, DEFAULT_HISTORY_TOKENS } from '../src/context/builder';
import { ContextStore } from '../src/context/store';
import { reportChatTurn } from '../src/cli/chat/turn/index';
import { runCompact } from '../src/cli/commands/cmds/compact';
import { ROLE, STOP_REASONS } from '../src/protocol';

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

function notes(store: ContextStore) {
  const said: string[] = [];
  const host: any = { render: { text: '', markdown: () => {}, note: (m: string) => said.push(m) }, workspace: {}, history: store };
  return { said, report: () => reportChatTurn(host, { content: 'ok', toolResults: [], iterations: 1, stopReason: STOP_REASONS.COMPLETE } as any, {}) };
}

describe('context filling up', () => {
  it('older history is capped at the default even with a 200k window', async () => {
    const budget = await request(conversation(200));
    assert.ok(budget.historyTokens <= DEFAULT_HISTORY_TOKENS + 500, `history ${budget.historyTokens}`);
    assert.ok(budget.dropped > 0);
  });

  it('warns once when nearly full, before anything is trimmed', async () => {
    let n = 1;
    let store = conversation(n);
    while ((await request(store)).historyNeeded / store.lastBudget!.historyRoom < 0.85) store = conversation(++n);
    assert.equal(store.lastBudget!.dropped, 0);
    const { said, report } = notes(store);
    await report();
    await report();
    assert.equal(said.length, 1, said.join(' | '));
    assert.match(said[0], /^Context is \d+% full\. When it fills, the oldest messages are trimmed automatically; type \/compact/);
  });

  it('says when it trimmed, and again only when trimming has doubled', async () => {
    const store = conversation(60);
    await request(store);
    const { said, report } = notes(store);
    await report();
    await report();
    assert.equal(said.length, 1, said.join(' | '));
    assert.match(said[0], /^Context trimmed to fit: the \d+ oldest messages are no longer sent to the model/);
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
