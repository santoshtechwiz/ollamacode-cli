import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../src/agent/planning/plan';
import { approvedPlanInput } from '../src/prompts/planning';
import { settlePlan } from '../src/agent/planning/settle';
import { AGENT_STATE, STOP_REASONS } from '../src/protocol';

const MARKDOWN_PLAN = [
  '## Goal',
  'A REST API in .NET with Swagger.',
  '',
  '## Implementation',
  '- **Initialize Project**: create the Web API project.',
  '  - `dotnet new webapi -n TodoApi`',
  '- **Install Dependencies**: add the NuGet packages.',
  '  - `Microsoft.EntityFrameworkCore.Sqlite`',
  '  - `Swashbuckle.AspNetCore`',
  '- **Swagger**: register it in Program.cs.',
  '```csharp',
  '- not a step inside a code block',
  '```',
  '| Layer | Tech |',
  '| - | - |',
  '',
  '## Validation',
  '1. Run: dotnet build',
].join('\n');

test('a plan in markdown keeps only its top-level steps, without emphasis', () => {
  const plan = parsePlan(MARKDOWN_PLAN);
  assert.equal(plan.steps.length, 4, plan.steps.join(' | '));
  assert.ok(plan.steps[0].startsWith('Initialize Project: create the Web API project.'), plan.steps[0]);
  assert.ok(!plan.steps.some((s) => s.includes('**')), 'markdown emphasis is not part of a step');
  assert.ok(!plan.steps.some((s) => s.includes('not a step')), 'code blocks are not steps');
  assert.equal(plan.steps[3], 'Run: dotnet build');
});

test('approving a plan asks for the plan to be carried out, not planned again', () => {
  const input = approvedPlanInput('1. Create the project\n2. Run: dotnet build');
  assert.match(input, /Carry it out now/);
  assert.match(input, /do not write another plan/);
  assert.match(input, /2\. Run: dotnet build/);
});

test('the summary counts only files changed after the plan was approved', () => {
  const box: any = {
    state: AGENT_STATE.COMPLETED,
    plan: { summary: 'api', steps: ['Edit src/a.cs', 'Edit src/b.cs'], files: { create: [], edit: [], del: [] }, runs: [], raw: 'x' },
    permissions: { plan_approved: true, action_approved: true },
    resumable: false,
    planChangesFrom: 1,
  };
  const workspace = {
    cwd: process.cwd(),
    state: {
      changes: [
        { op: 'create', path: 'hello.asm' },
        { op: 'edit', path: 'src/a.cs' },
        { op: 'edit', path: 'src/b.cs' },
      ],
    },
  };
  const result: any = { stopReason: STOP_REASONS.COMPLETE, content: 'Done.', toolResults: [] };

  settlePlan({ box, workspace, result });

  assert.deepEqual(result.planSummary.files, ['src/a.cs', 'src/b.cs']);
  assert.equal(result.planSummary.done, 2);
  assert.equal(box.plan, null);
});
