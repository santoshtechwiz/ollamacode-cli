import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTurnContext } from '../src/agent/turn/context';

describe('the project list the model is given', () => {
  it('is every project in the workspace, whatever the request says', async () => {
    const workspace: any = {
      cwd: '/tmp/ws',
      stacks: [
        { id: 'node', label: 'Node.js', root: '/tmp/ws/todo-app', markers: ['package.json'] },
        { id: 'dotnet', label: '.NET', root: '/tmp/ws/bid-app', markers: ['bid.sln'] },
      ],
      runtimes: {},
      contextLength: 131072,
    };
    const forRequest = async (input: string) =>
      (await buildTurnContext({ workspace, toolsEnabled: true, input, includeAutoContext: false })).system[0].content;
    const todo = await forRequest('create a todo app in node.js');
    const other = await forRequest('give me plan to implement e-hailing in node.js');
    assert.equal(todo, other, 'one request\'s words must not narrow the projects the model is told about');
    assert.match(String(todo), /bid-app/);
  });
});
