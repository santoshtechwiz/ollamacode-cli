import test from 'node:test';
import assert from 'node:assert/strict';
import { textToolsFit } from '../src/agent/workspace/profile';

const workspace = (contextWindow: number | undefined, maxTokens: number) =>
  ({ cwd: '/tmp/project', stacks: [], runtimes: {}, contextWindow, contextLength: contextWindow, maxTokens }) as any;

test('a 2k window cannot hold the tools written out as text', () => {
  assert.equal(textToolsFit(workspace(2048, 819)), false);
});

test('a 32k window holds them', () => {
  assert.equal(textToolsFit(workspace(32_768, 4096)), true);
});

test('an unknown window is not judged too small', () => {
  assert.equal(textToolsFit(workspace(undefined, 0)), true);
});
