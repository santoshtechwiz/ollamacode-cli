import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from '../src/prompts/system';

test('asked for a plan in Agent mode, the model answers with the plan and waits', () => {
  for (const brief of [false, true]) {
    const prompt = buildSystemPrompt({ cwd: '/tmp/project', toolsEnabled: true, brief });
    assert.match(prompt, /the plan is the whole answer[^.]*change nothing[^.]*start only when they say so/, `brief: ${brief}`);
  }
});
