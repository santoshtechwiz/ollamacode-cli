import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { judgeModel, parameterBillions } from '../src/agent/workspace/model-fit';
import { textToolsFit, chooseProfile } from '../src/agent/workspace/profile';
import { TOOLS } from '../src/tool/index';
import { selectToolDefs } from '../src/context/tool-surface';

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

describe('text-tools-fit', () => {
  const workspace = (contextWindow: number | undefined, maxTokens: number) =>
    ({ cwd: '/tmp/project', stacks: [], runtimes: {}, contextWindow, contextLength: contextWindow, maxTokens }) as any;

  test('a 2k window cannot hold the tools written out as text', () => {
    assert.equal(textToolsFit(workspace(2048, 819)), false);
  });
});

describe('tool-reach', () => {
  // Every profile ocode can choose, from the smallest window to the largest, local and remote.
  const chosen = [
    chooseProfile(2048), chooseProfile(8192), chooseProfile(32768), chooseProfile(200000),
    chooseProfile(undefined, { remote: true }), chooseProfile(200000, { remote: true }), chooseProfile(8192, { cpuOnly: true }),
  ];

  describe('every tool can reach a model', () => {
    it('a tool is offered by some profile ocode actually chooses, or by plan mode', () => {
      const reachable = new Set([
        ...chosen.flatMap((p) => selectToolDefs({ core: p.core, readOnly: false }).map((d) => d.name)),
        ...selectToolDefs({ readOnly: true }).map((d) => d.name),
      ]);
      const unreachable = TOOLS.map((t) => t.name).filter((name) => !reachable.has(name));
      // undo, save_memory and stop_process were named in ocode's own prompts and hints,
      // yet never offered: the model was told to call tools it did not have.
      assert.deepEqual(unreachable, []);
    });
  });
});
