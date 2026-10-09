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

test('a large model with tools and a wide window is ready', () => {
  const v = judgeModel({ model: 'qwen2.5-coder:14b', nativeTools: true, parameterSize: '14.8B', contextLength: 32_768 });
  assert.equal(v.fit, 'ready');
  assert.match(v.message, /14\.8B · tools · 32k window/);
});
