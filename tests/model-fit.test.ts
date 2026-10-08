import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeModel, parameterBillions } from '../src/agent/workspace/model-fit';

test('parameter sizes as backends report them', () => {
  assert.equal(parameterBillions('4.0B'), 4);
  assert.equal(parameterBillions('14.8B'), 14.8);
  assert.ok(Math.abs(parameterBillions('567M')! - 0.567) < 1e-9);
  assert.equal(parameterBillions(''), undefined);
  assert.equal(parameterBillions(undefined), undefined);
  assert.equal(parameterBillions('unknown'), undefined);
});

test('no tool support is unsuited, whatever its size', () => {
  const v = judgeModel({ model: 'big:70b', nativeTools: false, parameterSize: '70B', contextLength: 131_072 });
  assert.equal(v.fit, 'unsuited');
  assert.match(v.message, /no tool support/);
});

test('a window too short for instructions, tools and a file is unsuited', () => {
  assert.equal(judgeModel({ model: 'm', nativeTools: true, parameterSize: '14B', contextLength: 4096 }).fit, 'unsuited');
});

test('a small model on CPU is limited, and says what still works', () => {
  const v = judgeModel({ model: 'qwen3:4b-instruct', nativeTools: true, parameterSize: '4.0B', contextLength: 32_768, cpuOnly: true });
  assert.equal(v.fit, 'limited');
  assert.match(v.message, /is small \(4\.0B\) and runs on CPU/);
  assert.match(v.message, /precise one-step edits/);
  assert.match(v.message, /unreliable at multi-step coding/);
  assert.match(v.message, /minutes per reply/);
});

test('a capable model with a short window is limited for a different reason', () => {
  const v = judgeModel({ model: 'm', nativeTools: true, parameterSize: '14B', contextLength: 12_000 });
  assert.equal(v.fit, 'limited');
  assert.match(v.message, /short 12k window/);
  assert.doesNotMatch(v.message, /one-step edits/);
});

test('a large model with tools and a wide window is ready', () => {
  const v = judgeModel({ model: 'qwen2.5-coder:14b', nativeTools: true, parameterSize: '14.8B', contextLength: 32_768 });
  assert.equal(v.fit, 'ready');
  assert.match(v.message, /14\.8B · tools · 32k window/);
});

test('a cloud model that reports no size is ready and says the size is unknown', () => {
  const v = judgeModel({ model: 'nemotron-3-ultra:cloud', nativeTools: true, contextLength: 200_000, remote: true });
  assert.equal(v.fit, 'ready');
  assert.match(v.message, /size not reported/);
});

test('no tool support and a small window names both', () => {
  const v = judgeModel({ model: 'tinyllama:latest', nativeTools: false, parameterSize: '1.1B', contextLength: 2048 });
  assert.equal(v.fit, 'unsuited');
  assert.match(v.message, /no tool support and a 2k window/);
});
