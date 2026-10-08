// In agent mode present_plan shows the plan and asks whether to start; in plan mode the plan loop does that instead.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import presentPlan from '../src/agent/planning/present-plan.tool';
import { renderToolResult } from '../src/agent/router/render';
import '../src/tool/index';
import { ALWAYS_TOOLS } from '../src/context/tool-surface';

const plan = 'Goal: add security headers.\nImplementation:\n1. Add helmet; File: index.js\nValidation:\n1. Run: npm test';

describe('present_plan in agent mode', () => {
  it('asks the person whether to start, and an approval tells the model to carry it out', async () => {
    const asked: string[] = [];
    const state: any = {};
    const result: any = await presentPlan.execute({ plan }, { state, ask: async (q: string, options: string[]) => { asked.push(`${q} [${options.join(' / ')}]`); return 'Yes, start now'; } } as any);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /Goal: add security headers[\s\S]*Start this plan now\? \[Yes, start now \/ Not yet\]$/);
    assert.equal(result.data.approved, true);
    assert.match(renderToolResult(result, 'present_plan'), /The user approved this plan\. Carry it out now/);
  });

  it('"Not yet", or words of their own, leave everything unchanged and reach the model', async () => {
    const no: any = await presentPlan.execute({ plan }, { state: {}, ask: async () => 'Not yet' } as any);
    assert.equal(no.data.approved, false);
    assert.match(renderToolResult(no, 'present_plan'), /did not start this plan\. Change nothing/);
    const feedback: any = await presentPlan.execute({ plan }, { state: {}, ask: async () => 'use express-validator instead' } as any);
    assert.match(renderToolResult(feedback, 'present_plan'), /They said: use express-validator instead.*revise the plan/);
  });

  it('while plan mode explores it asks nothing: the plan loop shows its own approval', async () => {
    let asked = 0;
    const state: any = { planExploring: true };
    const result: any = await presentPlan.execute({ plan }, { state, ask: async () => { asked += 1; return 'Yes, start now'; } } as any);
    assert.equal(asked, 0);
    assert.equal(state.presentedPlan, plan, 'kept for the plan loop to read');
    assert.equal(result.display, 'Plan ready for your approval.');
  });

  it('in Ask or Review mode it offers no start: the plan is the answer', async () => {
    let asked = 0;
    const result: any = await presentPlan.execute({ plan }, { state: { reviewOnly: true }, ask: async () => { asked += 1; return 'Yes, start now'; } } as any);
    assert.equal(asked, 0);
    assert.equal(result.data.approved, false);
    assert.match(renderToolResult(result, 'present_plan'), /cannot change files.*Give the plan as your answer/);
  });

  it('with nobody to answer (a piped run) nothing waits on an approval', async () => {
    const state: any = {};
    const result: any = await presentPlan.execute({ plan }, { state } as any);
    assert.equal(state.presentedPlan, null);
    assert.match(renderToolResult(result, 'present_plan'), /Nobody can approve a plan in this session.*change nothing/);
  });

  it('its schema goes with every request, so a model told to use it can call it', () => {
    assert.ok(ALWAYS_TOOLS.includes('present_plan'));
  });
});
