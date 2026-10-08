import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { choiceFor } from '../src/ui/prompts';

describe('a choice prompt reads a number or the start of one option', () => {
  const labels = ['Yes, start now', 'Not yet'];
  it('takes the option number', () => {
    assert.equal(choiceFor('1', labels), 0);
    assert.equal(choiceFor('2', labels), 1);
    assert.equal(choiceFor('3', labels), null);
  });
  it('takes the start of a label, case-insensitively', () => {
    assert.equal(choiceFor('y', labels), 0);
    assert.equal(choiceFor('N', labels), 1);
    assert.equal(choiceFor('not', labels), 1);
  });
  it('an answer that fits no option, or more than one, picks nothing', () => {
    assert.equal(choiceFor('maybe', labels), null);
    assert.equal(choiceFor('n', ['No', 'Not yet']), null);
  });
});
