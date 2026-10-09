import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import '../src/tool/index';
import { prepareCall } from '../src/tool/execution/prepare';

const errorOf = (name: string, args: Record<string, unknown>) => {
  const r: any = prepareCall(name, args);
  return r.ok ? null : String(r.result.error);
};

describe('a wrong list item says what an item is, from the schema', () => {
  it('an object item names its fields and what was sent', () => {
    assert.equal(errorOf('todo_write', { todos: ['Install deps'] }), 'todos[0] must be an object {content, status}, received a string');
  });
});
