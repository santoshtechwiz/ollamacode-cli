// present_plan shows the plan and asks whether to start, in Agent mode and in Plan mode alike.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import presentPlan from '../src/agent/planning/present-plan.tool';
import { renderToolResult } from '../src/agent/router/render';
import '../src/tool/index';
import { selectToolDefs } from '../src/context/tool-surface';

const plan = 'Goal: add security headers.\nImplementation:\n1. Add helmet; File: index.js\nValidation:\n1. Run: npm test';

describe('present_plan in agent mode', () => {
  it('asks the person whether to start, and an approval tells the model to carry it out', async () => {
    const asked: string[] = [];
    const state: any = {};
    const result: any = await presentPlan.execute({ plan }, { state, ask: async (q: string, options: string[], opts: any) => { asked.push(`${opts?.detail}\n${q} [${options.join(' / ')}]`); return 'Yes, start now'; } } as any);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^\*\*Where:\*\* the workspace root\n\nGoal: add security headers[\s\S]*\nStart this plan now\? \[Yes, start now \/ Change something \/ Not yet\]$/, 'where, then the plan, above a one-line question');
    assert.equal(result.data.approved, true);
    assert.match(renderToolResult(result, 'present_plan'), /The user approved this plan\. Carry it out now/);
  });

  it('shows the steps with the plan, so the person approves what becomes the task list', async () => {
    let detail = '';
    await presentPlan.execute(
      { plan: 'Build an e-hailing backend.', folder: 'e-hailing-service', steps: ['Create the project', 'Add ride APIs', 'Run the tests'] },
      { state: {}, ask: async (_q: string, _o: string[], opts: any) => { detail = opts?.detail; return 'Not yet'; } } as any,
    );
    assert.equal(detail, '**Where:** `e-hailing-service/`\n\nBuild an e-hailing backend.\n\n**Steps**\n1. Create the project\n2. Add ride APIs\n3. Run the tests');
  });

  it('"Not yet", or words of their own, leave everything unchanged and reach the model', async () => {
    const no: any = await presentPlan.execute({ plan }, { state: {}, ask: async () => 'Not yet' } as any);
    assert.equal(no.data.approved, false);
    assert.match(renderToolResult(no, 'present_plan'), /did not start this plan\. Change nothing/);
    const feedback: any = await presentPlan.execute({ plan }, { state: {}, ask: async () => 'use express-validator instead' } as any);
    assert.match(renderToolResult(feedback, 'present_plan'), /asked for changes: use express-validator instead[\s\S]*present_plan again/);
  });

  it('in plan mode it asks the same, and an approval ends plan mode', async () => {
    let asked = 0;
    const state: any = { planExploring: true };
    const result: any = await presentPlan.execute({ plan }, { state, ask: async () => { asked += 1; return 'Yes, start now'; } } as any);
    assert.equal(asked, 1);
    assert.equal(result.data.approved, true);
    assert.equal(state.planExploring, false);
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
    assert.equal(state.planHeld, true);
    assert.match(renderToolResult(result, 'present_plan'), /Nobody can approve a plan in this session.*change nothing/);
  });

  it('asks for a plan the user can trust: goal, location, current state, approach, changes, decisions, risks, verification', () => {
    const asked = String((presentPlan.parameters as any).properties.plan.description);
    for (const heading of ['Goal', 'Current state', 'Approach', 'Changes', 'Decisions and assumptions', 'Risks', 'Verification']) {
      assert.match(asked, new RegExp(`## ${heading}`), heading);
    }
  });

  it('an approved folder is made, and becomes where commands with no folder run once something is in it', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { createWorkspaceState, workingProject } = await import('../src/context/workspace-state');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-plan-folder-'));
    try {
      const state: any = createWorkspaceState(root);
      await presentPlan.execute({ plan, folder: 'e-hailing-service' }, { state, root, cwd: root, ask: async () => 'Yes, start now' } as any);
      assert.ok(fs.existsSync(path.join(root, 'e-hailing-service')));
      // Still empty: a scaffolder given the folder's name runs from the root and fills it, instead of nesting a copy.
      assert.equal(workingProject(state), null);
      fs.writeFileSync(path.join(root, 'e-hailing-service', 'package.json'), '{}');
      assert.equal(workingProject(state), path.join(root, 'e-hailing-service'));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('the folder is required, so where the work goes is always decided before it starts', () => {
    assert.ok((presentPlan.parameters as any).required.includes('folder'));
  });

  it('its schema goes with every request, so a model told to use it can call it', () => {
    assert.ok(selectToolDefs({ core: true }).some((def) => def.name === 'present_plan'));
  });
});
