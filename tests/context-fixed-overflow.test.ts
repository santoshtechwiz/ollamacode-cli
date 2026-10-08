import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { ROLE } from '../src/protocol';

test('instructions larger than the window fail with that reason, without compacting an empty conversation', async () => {
  const history = new ContextStore({ messages: [] });
  history.addUser('what is c#', { pinned: true });
  let compactions = 0;
  let modelCalls = 0;

  const fail = runTurn({
    model: 'tinyllama:latest',
    history,
    systemMessages: [{ role: ROLE.SYSTEM, content: 'instructions '.repeat(2000) }],
    config: { maxIterations: 3, contextWindow: 2048, maxTokens: 819 },
    toolsEnabled: false,
    gateway: {
      model: 'tinyllama:latest',
      provider: { id: 'ollama' },
      async stream() {
        modelCalls++;
        throw new Error('must not be sent');
      },
    } as any,
    toolRunner: { async run() { throw new Error('must not run'); } } as any,
    compactor: (() => {
      compactions++;
      return { capacityTokens: 0, dropped: 0 };
    }) as any,
  });

  await assert.rejects(fail, /tinyllama:latest's 2,048-token window can't hold ocode's instructions .* \/tools/);
  assert.equal(compactions, 0, 'there was nothing compaction could drop');
  assert.equal(modelCalls, 0, 'a request known not to fit is never sent');
});
