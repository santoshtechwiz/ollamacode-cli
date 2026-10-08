import test from 'node:test';
import assert from 'node:assert/strict';
import { describeToolResult } from '../src/ui/tool-preview';
import { layoutTaskList, taskListLines } from '../src/ui/render/task-list';
import type { ToolResult } from '../src/types';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const item = (status: any, title: string) => ({ title, status });

test('a todo_write result is one line: the list itself is shown once, in the live checklist', () => {
  const v = describeToolResult('todo_write', { ok: true, kind: 'text', display: '[x] Install socket.io\n[~] Wire the server\n[ ] Run the tests' } as ToolResult);
  assert.deepEqual(v.detail, []);
  assert.match(strip(v.title), /1 of 3 done/);
});

test('a list with work left is drawn in full', () => {
  const lines = taskListLines([item('done', 'Install socket.io'), item('active', 'Run the tests'), item('open', 'Ship it')]).map(strip);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /Run the tests/);
  assert.match(lines[2], /Ship it/);
});

test('a finished list collapses to one line', () => {
  assert.deepEqual(layoutTaskList([item('done', 'A'), item('done', 'B')]), [{ kind: 'summary', text: 'all 2 steps done' }]);
  assert.deepEqual(layoutTaskList([item('done', 'Only step')]), [{ kind: 'summary', text: 'all 1 step done' }]);
});

test('an empty list draws nothing', () => {
  assert.deepEqual(layoutTaskList([]), []);
});

test('a long list keeps every open task and counts the finished ones', () => {
  const rows = layoutTaskList([...Array.from({ length: 30 }, (_, i) => item('done', `finished ${i}`)), item('active', 'broke'), item('open', 'still to do')]);
  assert.deepEqual(rows[0], { kind: 'summary', text: '30 done' });
  assert.deepEqual(rows.slice(1).map((r: any) => r.title), ['broke', 'still to do']);
});
