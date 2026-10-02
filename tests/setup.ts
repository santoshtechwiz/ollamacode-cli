import assert from 'node:assert/strict';

globalThis.expect = (actual: unknown) => ({
  toBe(expected: unknown) {
    assert.equal(actual, expected);
  },
  toEqual(expected: unknown) {
    assert.deepEqual(actual, expected);
  },
  not: {
    toBe(expected: unknown) {
      assert.notEqual(actual, expected);
    },
    toEqual(expected: unknown) {
      assert.notDeepEqual(actual, expected);
    },
    toContain(expected: unknown) {
      if (Array.isArray(actual)) {
        assert.ok(!actual.includes(expected), `Expected array not to contain ${expected}`);
      } else if (typeof actual === 'string') {
        assert.ok(!actual.includes(String(expected)), `Expected string not to contain ${expected}`);
      } else {
        throw new Error('toContain only works on arrays and strings');
      }
    },
  },
  toContain(expected: unknown) {
    if (Array.isArray(actual)) {
      assert.ok(actual.includes(expected), `Expected array to contain ${expected}`);
    } else if (typeof actual === 'string') {
      assert.ok(actual.includes(String(expected)), `Expected string to contain ${expected}`);
    } else {
      throw new Error('toContain only works on arrays and strings');
    }
  },
});