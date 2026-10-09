// present_plan shows the plan and asks whether to start, in Agent mode and in Plan mode alike.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import presentPlan from '../src/agent/planning/present-plan.tool';
import { renderToolResult } from '../src/agent/router/render';
import '../src/tool/index';

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

  it('in Ask or Review mode it offers no start: the plan is the answer', async () => {
    let asked = 0;
    const result: any = await presentPlan.execute({ plan }, { state: { reviewOnly: true }, ask: async () => { asked += 1; return 'Yes, start now'; } } as any);
    assert.equal(asked, 0);
    assert.equal(result.data.approved, false);
    assert.match(renderToolResult(result, 'present_plan'), /cannot change files.*Give the plan as your answer/);
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
});
