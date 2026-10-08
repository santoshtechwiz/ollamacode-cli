import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createAgentRuntime } from '../src/agent/runtime';
import todoWrite, { taskTodos } from '../src/agent/planning/todo-write.tool';
import { createAgentState } from '../src/agent/state';
import { ContextStore } from '../src/context/store';
import { createWorkspaceState } from '../src/context/workspace-state';
import { ROLE } from '../src/protocol';

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: args } });

// The runtime builds its own gateway from a provider; the test replaces that gateway with a scripted one.
const never = async () => { throw new Error('not used'); };
const STUB_PROVIDER = { id: 'test', label: 'test', detect: never, ensureAuth: never, listModels: never, streamChat: never };

// A runtime over a throwaway folder, with a scripted model; the only tool it calls is the real todo_write.
function runtimeWith(replies: any[]) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-tasks-'));
  const workspace: any = { cwd, state: createWorkspaceState(cwd), nativeTools: true };
  const runtime = createAgentRuntime({
    provider: STUB_PROVIDER, model: 'test', config: { maxIterations: 4 }, checkpoints: false,
    workspace, history: new ContextStore({ messages: [], budgetTokens: 8000 }), agentState: createAgentState(),
  });
  let asked = 0;
  (runtime as any).gateway = {
    model: 'test',
    provider: { id: 'test' },
    async stream() {
      const next = replies[asked++] ?? { content: 'Done.' };
      return { result: { content: next.content ?? '', toolCalls: next.toolCalls ?? [], finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
    },
  };
  const toolRunner = {
    // The real todo_write, so the test sees exactly what it records.
    async run(name: string, args: any) {
      return { result: await todoWrite.execute(args, { state: workspace.state } as any) };
    },
  };
  return { runtime, workspace, toolRunner, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

describe('the task list belongs to its task', () => {
  it('a new task starts without the previous task\'s list', async () => {
    const list = [{ content: 'Write the parser', status: 'completed' }];
    const t = runtimeWith([
      { toolCalls: [call('1', 'todo_write', { todos: list })] },
      { content: 'Parser written.' },
      { content: 'Hello.' },
    ]);
    try {
      await t.runtime.execute({ input: 'write the parser', toolRunner: t.toolRunner });
      assert.equal(taskTodos(t.workspace.state).length, 1, 'the first task has its list');

      await t.runtime.execute({ input: 'say hello', toolRunner: t.toolRunner });
      assert.deepEqual(taskTodos(t.workspace.state), [], 'the next task does not take it for its own');
      assert.ok(t.runtime.history.messages.some((m: any) => m.role === ROLE.USER && m.content === 'say hello'));
    } finally {
      t.cleanup();
    }
  });
});
