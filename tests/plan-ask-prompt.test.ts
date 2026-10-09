import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from '../src/prompts/system';

test('asked for a plan in Agent mode, the model presents it, waits, and carries it out once approved', () => {
  for (const brief of [false, true]) {
    const prompt = buildSystemPrompt({ cwd: '/tmp/project', toolsEnabled: true, brief });
    assert.match(prompt, /change nothing[^.]*present_plan[^.]*whether to start\.\s+If\s+they\s+approve,\s+carry\s+it\s+out\s+in\s+the\s+same\s+turn/, `brief: ${brief}`);
    // "The plan is the whole answer" read as "stop after the plan", even once it was approved.
    assert.doesNotMatch(prompt, /the plan is the whole answer/, `brief: ${brief}`);
  }
});
