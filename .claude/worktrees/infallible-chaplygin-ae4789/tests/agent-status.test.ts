import test from 'node:test';
import assert from 'node:assert/strict';

import { activityForTool } from '../src/agent/status';
import '../src/tool/index.ts';

test('names the activity a tool declares for itself', () => {
  assert.equal(activityForTool('load_tools'), 'Loading tools');
  assert.equal(activityForTool('exec_shell'), 'Running a command');
  assert.equal(activityForTool('grep_content'), 'Searching file contents');
  assert.equal(activityForTool('read_file'), 'Reading a file');
  assert.equal(activityForTool('ask_user'), 'Waiting for your answer');
});

test('resolves an alias or a loosely written name to the same activity', () => {
  assert.equal(activityForTool('cat'), 'Reading a file');
  assert.equal(activityForTool('read-file'), 'Reading a file');
});

test('a tool the registry does not know still leaves the loader something true to show', () => {
  assert.equal(activityForTool('some_new_tool'), 'some_new_tool');
});
