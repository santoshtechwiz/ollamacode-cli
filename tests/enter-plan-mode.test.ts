import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import enterPlanMode from '../src/agent/planning/enter-plan-mode.tool';
import { renderToolResult } from '../src/agent/router/render';
import '../src/tool/index';
import { selectToolDefs } from '../src/context/tool-surface';

describe('enter_plan_mode', () => {
  it('puts the session in plan mode and gives the model plan mode\'s instructions', async () => {
    const state: any = {};
    const result: any = await enterPlanMode.execute({}, { state } as any);
    assert.equal(state.planExploring, true);
    assert.match(renderToolResult(result, 'enter_plan_mode'), /PLAN MODE[\s\S]*present_plan/);
  });

  it('in Ask or Review mode it changes nothing', async () => {
    const state: any = { reviewOnly: true };
    await enterPlanMode.execute({}, { state } as any);
    assert.equal(state.planExploring, undefined);
  });

  it('is offered in agent mode, and not in the read-only modes', () => {
    assert.ok(selectToolDefs({ core: true }).some((def) => def.name === 'enter_plan_mode'));
    assert.ok(!selectToolDefs({ readOnly: true }).some((def) => def.name === 'enter_plan_mode'));
  });
});
