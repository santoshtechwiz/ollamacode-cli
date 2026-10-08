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

test('replies talk about the project, never about ocode\'s own tools', () => {
  for (const brief of [false, true]) {
    assert.match(buildSystemPrompt({ cwd: '/tmp/project', toolsEnabled: true, brief }), /never name your tools/, `brief: ${brief}`);
  }
});

test('a new project is asked about or given its own folder, never dropped in the root or another project', () => {
  for (const brief of [false, true]) {
    const prompt = buildSystemPrompt({ cwd: '/tmp/project', toolsEnabled: true, brief });
    assert.match(prompt, /new application or service[\s\S]*ask once with ask_user/, `brief: ${brief}`);
    assert.match(prompt, /never goes in the workspace root when the root already holds other projects/, `brief: ${brief}`);
  }
});
