import test from 'node:test';
import assert from 'node:assert/strict';
import { describeToolResult, todoRows } from '../src/ui/tool-preview';
import type { ToolResult } from '../src/types';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
// The live checklist draws a task list with todoRows; the todo_write result row only counts it.
const rows = (display: string) => todoRows(display).map(strip);

test('a todo_write result is one line: the list itself is shown once, in the live checklist', () => {
  const v = describeToolResult('todo_write', { ok: true, kind: 'text', display: '[x] Install socket.io\n[~] Wire the server\n[ ] Run the tests' } as ToolResult);
  assert.deepEqual(v.detail, []);
  assert.match(strip(v.title), /1 of 3 done/);
});

test('a list with work left stays on screen in full', () => {
  const lines = rows('[x] Install socket.io\n[~] Wire the server\n[ ] Run the tests');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /Wire the server/);
  assert.match(lines[2], /Run the tests/);
});

test('a finished list collapses to one line', () => {
  assert.deepEqual(rows('[x] Install socket.io\n[x] Wire the server\n[x] Wire the client\n[x] Run the tests'), ['all 4 steps done']);
});

test('one lone completed step still reads as done', () => {
  assert.deepEqual(rows('[x] Only step'), ['all 1 step done']);
});

test('an empty list renders nothing', () => {
  assert.deepEqual(rows(''), []);
});

test('a long list with work left keeps the open steps and counts the rest', () => {
  const display = [
    ...Array.from({ length: 30 }, (_, i) => `[x] finished ${i}`),
    '[ ] still to do',
  ].join('\n');
  const lines = rows(display);
  assert.match(lines[0], /30 completed/);
  assert.match(lines[lines.length - 1], /still to do/);
});
