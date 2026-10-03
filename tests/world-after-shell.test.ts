import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../src/tool/index';
import { runTurn } from '../src/agent/turn/turn';
import { ContextStore } from '../src/context/store';
import { createWorkspaceState } from '../src/context/workspace-state';
import { createAgentState } from '../src/agent/state';
import { createExecutor } from '../src/tool/execution/executor';
import { applyApprovalPolicy } from '../src/tool/policy/permission-policy';
import { selectToolDefs } from '../src/context/tool-surface';

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, type: 'function', function: { name, arguments: args } });

test('a file changed by a shell command is read again, not handed back from before', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ocode-world-'));
  try {
    fs.writeFileSync(path.join(cwd, 'notes.txt'), 'before\n');
    const state: any = createWorkspaceState(cwd);
    state.permissions = createAgentState().permissions;
    applyApprovalPolicy(state, { yes: true });
    const toolRunner = createExecutor({ root: cwd, state, timeoutMs: 20_000 });

    const replies = [
      [call('1', 'read_file', { path: 'notes.txt' })],
      [call('2', 'exec_shell', { command: `node -e "require('fs').writeFileSync('notes.txt', 'after\\n')"` })],
      [call('3', 'read_file', { path: 'notes.txt' })],
      [],
    ];
    const history = new ContextStore({ messages: [] });
    history.addUser('read notes.txt, update it, read it again', { pinned: true });

    const turn = await runTurn({
      model: 'test',
      history,
      config: { maxIterations: 6 },
      // As executeTurn sends them: every tool the profile allows, in full.
      toolProfile: { always: selectToolDefs({}).map((def) => def.name) },
      cwd,
      state,
      toolRunner,
      gateway: {
        model: 'test',
        provider: { id: 'test' },
        async stream() {
          const toolCalls = replies.shift() ?? [];
          return { result: { content: toolCalls.length ? '' : 'done', toolCalls, finishReason: 'stop' }, attempt: 1, retries: 0, startedAt: Date.now() };
        },
      } as any,
    });

    const reads = turn.toolResults.filter((r) => r.name === 'read_file');
    assert.equal(reads.length, 2, 'the second read ran instead of being reused');
    assert.match(String(reads[1].result.display ?? ''), /after/);
    assert.doesNotMatch(String(reads[1].result.display ?? ''), /Reused/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
