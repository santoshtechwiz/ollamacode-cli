import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import enterPlanMode from '../src/agent/planning/enter-plan-mode.tool';
import '../src/tool/index';

describe('enter_plan_mode', () => {

  it('in Ask or Review mode it changes nothing', async () => {
    const state: any = { reviewOnly: true };
    await enterPlanMode.execute({}, { state } as any);
    assert.equal(state.planExploring, undefined);
  });
});
