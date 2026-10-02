import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TOOLS } from '../src/tool/index';
import { selectToolDefs } from '../src/context/tool-surface';
import { chooseProfile } from '../src/agent/workspace/profile';
import { TOOL_NAME } from '../src/protocol';

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
      TOOL_NAME.LOAD_TOOLS,
    ]);
    const unreachable = TOOLS.map((t) => t.name).filter((name) => !reachable.has(name));
    // ensure_toolchain, undo, save_memory and stop_process were named in ocode's own prompts and hints,
    // yet never offered: the model was told to call tools it did not have, and refused to install .NET.
    assert.deepEqual(unreachable, []);
  });
});
